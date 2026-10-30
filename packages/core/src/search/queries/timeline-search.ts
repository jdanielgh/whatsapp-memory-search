// Timeline Search — Q-TL-01 a Q-TL-03 de docs/QUERY_CATALOG.md.
// Cierra UC-012 (consultar cronología) y alimenta UC-011.

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  cases,
  eventMessages,
  events,
  messages,
} from "../../infrastructure/db/schema.js";
import type { SearchPage } from "./exact-search.js";

export interface TimelineEvent {
  id: string;
  type: string;
  occurredAt: Date;
  caseId: string;
  caseTitle: string;
  caseCategory: string;
  /** Ids de los mensajes que lo respaldan — la evidencia completa se pide con Q-EV-02. */
  messageIds: string[];
}

const DEFAULT_TIMELINE_LIMIT = 200;

/** Mismo motivo que en Exact Search: un resultado en el tope no puede confundirse con uno completo. */
function paginate<T>(fetched: T[], limit: number): SearchPage<T> {
  return { items: fetched.slice(0, limit), truncated: fetched.length > limit };
}

async function attachMessageIds(
  db: Database,
  rows: Omit<TimelineEvent, "messageIds">[]
): Promise<TimelineEvent[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select({ eventId: eventMessages.eventId, messageId: eventMessages.messageId })
    .from(eventMessages)
    .where(
      inArray(
        eventMessages.eventId,
        rows.map((r) => r.id)
      )
    );

  const byEvent = new Map<string, string[]>();
  for (const link of links) {
    const list = byEvent.get(link.eventId) ?? [];
    list.push(link.messageId);
    byEvent.set(link.eventId, list);
  }
  // Se incluyen los ids de evidencia en la propia cronología para que
  // nadie tenga que mostrar un Event "pelado": pedir el detalle sigue
  // pasando por Q-EV-02, pero la trazabilidad ya viene puesta (SI-037).
  return rows.map((row) => ({ ...row, messageIds: byEvent.get(row.id) ?? [] }));
}

/** Q-TL-01 — Eventos de la conversación en un rango, ordenados. `to` exclusivo. */
export async function findEventsInRange(
  input: { conversationId: string; from: Date; to: Date; limit?: number },
  db: Database = defaultDb
): Promise<SearchPage<TimelineEvent>> {
  const limit = input.limit ?? DEFAULT_TIMELINE_LIMIT;
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      caseId: cases.id,
      caseTitle: cases.title,
      caseCategory: cases.category,
    })
    .from(events)
    .innerJoin(cases, eq(cases.id, events.caseId))
    .where(
      and(
        eq(cases.conversationId, input.conversationId),
        gte(events.occurredAt, input.from),
        sql`${events.occurredAt} < ${input.to}`
      )
    )
    .orderBy(asc(events.occurredAt), asc(events.id))
    .limit(limit + 1);

  const page = paginate(rows, limit);
  return { items: await attachMessageIds(db, page.items), truncated: page.truncated };
}

/** Q-TL-02 — Cronología completa de un Case (UC-011, UC-012). */
export async function findCaseTimeline(
  input: { caseId: string; limit?: number },
  db: Database = defaultDb
): Promise<SearchPage<TimelineEvent>> {
  const limit = input.limit ?? DEFAULT_TIMELINE_LIMIT;
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      caseId: cases.id,
      caseTitle: cases.title,
      caseCategory: cases.category,
    })
    .from(events)
    .innerJoin(cases, eq(cases.id, events.caseId))
    .where(eq(events.caseId, input.caseId))
    .orderBy(asc(events.occurredAt), asc(events.id))
    .limit(limit + 1);

  const page = paginate(rows, limit);
  return { items: await attachMessageIds(db, page.items), truncated: page.truncated };
}

export interface ParticipantActivity {
  messagesSent: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  /** Eventos en los que participó, vía los mensajes que los respaldan. */
  events: SearchPage<TimelineEvent>;
}

/**
 * Q-TL-03 — Actividad de un participante en el tiempo (UC-022).
 *
 * Los conteos se resuelven con agregación en SQL, no trayendo los
 * mensajes a memoria para contarlos (mismo criterio que Q-ST-01): un
 * participante puede tener miles.
 */
export async function findParticipantActivity(
  input: { participantId: string; limit?: number },
  db: Database = defaultDb
): Promise<ParticipantActivity> {
  // Los agregados en SQL crudo vuelven como string, no como Date: Drizzle
  // solo convierte las columnas que conoce por el esquema. Anotarlos como
  // `Date` compilaría pero mentiría, y el primer `.getTime()` río abajo
  // reventaría en runtime.
  const [totals] = await db
    .select({
      messagesSent: sql<number>`count(*)::int`,
      firstMessageAt: sql<string | null>`min(${messages.sentAt})`,
      lastMessageAt: sql<string | null>`max(${messages.sentAt})`,
    })
    .from(messages)
    .where(eq(messages.participantId, input.participantId));

  const limit = input.limit ?? DEFAULT_TIMELINE_LIMIT;
  const rows = await db
    .selectDistinct({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      caseId: cases.id,
      caseTitle: cases.title,
      caseCategory: cases.category,
    })
    .from(events)
    .innerJoin(cases, eq(cases.id, events.caseId))
    .innerJoin(eventMessages, eq(eventMessages.eventId, events.id))
    .innerJoin(messages, eq(messages.id, eventMessages.messageId))
    .where(eq(messages.participantId, input.participantId))
    .orderBy(asc(events.occurredAt), asc(events.id))
    .limit(limit + 1);

  const page = paginate(rows, limit);
  return {
    messagesSent: totals?.messagesSent ?? 0,
    firstMessageAt: totals?.firstMessageAt ? new Date(totals.firstMessageAt) : null,
    lastMessageAt: totals?.lastMessageAt ? new Date(totals.lastMessageAt) : null,
    events: {
      items: await attachMessageIds(db, page.items),
      truncated: page.truncated,
    },
  };
}
