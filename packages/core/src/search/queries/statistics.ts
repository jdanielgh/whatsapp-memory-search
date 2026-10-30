// Statistics — Q-ST-01 de docs/QUERY_CATALOG.md (UC-023).
//
// plans/ lo pide explícito: se resuelve con COUNT/GROUP BY a nivel de
// SQL, sin traer filas a memoria para contarlas. Sobre miles de mensajes la
// diferencia no es de estilo — cargar el historial completo para contar
// también contradiría la regla de no volcar la conversación a memoria ni
// al contexto del agente.

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  cases,
  events,
  messages,
  participants,
  reminders,
} from "../../infrastructure/db/schema.js";

export interface ConversationStatistics {
  messageCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  eventCount: number;
  openCaseCount: number;
  pendingReminderCount: number;
  messagesByParticipant: {
    participantId: string;
    displayName: string;
    messageCount: number;
  }[];
}

/** Q-ST-01 — Estadísticas generales de la conversación (UC-023). */
export async function getConversationStatistics(
  conversationId: string,
  db: Database = defaultDb
): Promise<ConversationStatistics> {
  const [messageTotals] = await db
    .select({
      messageCount: sql<number>`count(*)::int`,
      // String, no Date: Drizzle solo convierte columnas que conoce por
      // el esquema, no el resultado de un agregado en SQL crudo.
      firstMessageAt: sql<string | null>`min(${messages.sentAt})`,
      lastMessageAt: sql<string | null>`max(${messages.sentAt})`,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  // Los eventos cuelgan de Cases, y los Cases de la Conversation: hay que
  // pasar por el join para no contar los de otra conversación.
  const [eventTotals] = await db
    .select({ eventCount: sql<number>`count(${events.id})::int` })
    .from(events)
    .innerJoin(cases, eq(cases.id, events.caseId))
    .where(eq(cases.conversationId, conversationId));

  const [caseTotals] = await db
    .select({ openCaseCount: sql<number>`count(*)::int` })
    .from(cases)
    .where(and(eq(cases.conversationId, conversationId), eq(cases.status, "open")));

  const [reminderTotals] = await db
    .select({ pendingReminderCount: sql<number>`count(*)::int` })
    .from(reminders)
    .where(
      and(
        eq(reminders.conversationId, conversationId),
        eq(reminders.status, "pending")
      )
    );

  const distribution = await db
    .select({
      participantId: participants.id,
      displayName: participants.displayName,
      messageCount: sql<number>`count(${messages.id})::int`,
    })
    .from(participants)
    // leftJoin para que un participante sin mensajes aparezca con 0 en
    // vez de desaparecer del reparto.
    .leftJoin(messages, eq(messages.participantId, participants.id))
    .where(eq(participants.conversationId, conversationId))
    .groupBy(participants.id, participants.displayName)
    // El desempate por nombre no es cosmético: sin él, dos participantes
    // con el mismo conteo salen en orden arbitrario y la misma consulta
    // devuelve resultados distintos entre llamadas.
    .orderBy(sql`count(${messages.id}) desc`, participants.displayName);

  return {
    messageCount: messageTotals?.messageCount ?? 0,
    firstMessageAt: messageTotals?.firstMessageAt
      ? new Date(messageTotals.firstMessageAt)
      : null,
    lastMessageAt: messageTotals?.lastMessageAt
      ? new Date(messageTotals.lastMessageAt)
      : null,
    eventCount: eventTotals?.eventCount ?? 0,
    openCaseCount: caseTotals?.openCaseCount ?? 0,
    pendingReminderCount: reminderTotals?.pendingReminderCount ?? 0,
    messagesByParticipant: distribution,
  };
}
