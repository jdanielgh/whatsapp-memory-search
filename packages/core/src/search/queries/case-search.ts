// Case Search — Q-CS-01 a Q-CS-03 de docs/QUERY_CATALOG.md.
// Cierra UC-011 (consultar un Case) y alimenta UC-023.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import { cases, events, insights, summaries } from "../../infrastructure/db/schema.js";
import type { SearchPage } from "./exact-search.js";
import { findCaseTimeline, type TimelineEvent } from "./timeline-search.js";

export interface CaseSummaryRow {
  id: string;
  title: string;
  category: string;
  status: string;
  eventCount: number;
  lastEventAt: Date | null;
}

export interface CaseDetail {
  case: { id: string; title: string; category: string; status: string; createdAt: Date };
  /** Cronología completa, con los ids de evidencia de cada Event ya incluidos. */
  timeline: SearchPage<TimelineEvent>;
  insights: { id: string; statement: string; confidence: number; derivedFromEventIds: string[] }[];
  summaries: { id: string; scope: string; content: string; generatedAt: Date }[];
}

/**
 * Q-CS-01 — Todo lo que se sabe de un Case (UC-011).
 *
 * Devuelve el paquete completo (eventos + insights + resúmenes) con la
 * trazabilidad a evidencia ya incluida en cada Event. La evidencia
 * textual íntegra se pide aparte con Q-EV-02 por Event: traerla toda acá
 * significaría volcar cientos de mensajes de una conversación real en una
 * sola respuesta, algo que `CLAUDE.md` regla 2 y
 * `rules/security-privacy.md` regla 1 desaconsejan salvo pedido
 * explícito.
 */
export async function findCaseDetail(
  caseId: string,
  db: Database = defaultDb
): Promise<CaseDetail | null> {
  const [row] = await db
    .select({
      id: cases.id,
      title: cases.title,
      category: cases.category,
      status: cases.status,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId));
  if (!row) return null;

  const timeline = await findCaseTimeline({ caseId }, db);

  const caseInsights = await db
    .select({
      id: insights.id,
      statement: insights.statement,
      confidence: insights.confidence,
      derivedFromEventIds: insights.derivedFromEventIds,
    })
    .from(insights)
    .where(eq(insights.caseId, caseId))
    .orderBy(desc(insights.updatedAt));

  const caseSummaries = await db
    .select({
      id: summaries.id,
      scope: summaries.scope,
      content: summaries.content,
      generatedAt: summaries.generatedAt,
    })
    .from(summaries)
    .where(and(eq(summaries.subjectType, "Case"), eq(summaries.subjectId, caseId)))
    .orderBy(desc(summaries.generatedAt));

  return {
    case: row,
    timeline,
    insights: caseInsights.map((i) => ({
      id: i.id,
      statement: i.statement,
      confidence: Number(i.confidence),
      derivedFromEventIds: i.derivedFromEventIds,
    })),
    summaries: caseSummaries,
  };
}

/**
 * Conteos por Case resueltos con GROUP BY, no recorriendo eventos en
 * memoria — mismo criterio que Q-ST-01.
 */
async function listCases(
  db: Database,
  where: ReturnType<typeof and>
): Promise<CaseSummaryRow[]> {
  const rows = await db
    .select({
      id: cases.id,
      title: cases.title,
      category: cases.category,
      status: cases.status,
      eventCount: sql<number>`count(${events.id})::int`,
      // String, no Date: los agregados en SQL crudo no los convierte
      // Drizzle (solo convierte columnas que conoce por el esquema).
      lastEventAt: sql<string | null>`max(${events.occurredAt})`,
    })
    .from(cases)
    .leftJoin(events, eq(events.caseId, cases.id))
    .where(where)
    .groupBy(cases.id, cases.title, cases.category, cases.status, cases.updatedAt)
    .orderBy(desc(cases.updatedAt));

  return rows.map((row) => ({
    ...row,
    lastEventAt: row.lastEventAt ? new Date(row.lastEventAt) : null,
  }));
}

/** Q-CS-02 — Cases abiertos con su conteo de eventos (UC-023). */
export async function findOpenCases(
  conversationId: string,
  db: Database = defaultDb
): Promise<CaseSummaryRow[]> {
  return listCases(
    db,
    and(eq(cases.conversationId, conversationId), eq(cases.status, "open"))
  );
}

/** Q-CS-03 — Cases por categoría (UC-011, UC-023). */
export async function findCasesByCategory(
  input: { conversationId: string; category: string },
  db: Database = defaultDb
): Promise<CaseSummaryRow[]> {
  return listCases(
    db,
    and(
      eq(cases.conversationId, input.conversationId),
      eq(cases.category, input.category)
    )
  );
}

/** Lista todos los Cases de la conversación, para navegación. */
export async function findAllCases(
  conversationId: string,
  db: Database = defaultDb
): Promise<CaseSummaryRow[]> {
  return listCases(db, eq(cases.conversationId, conversationId));
}
