// Evidence Search — Q-EV-01, Q-EV-02, Q-EV-03 de docs/QUERY_CATALOG.md.
// Cierra UC-013 (consultar evidencia) y sostiene UC-019 (explicar una
// respuesta).
//
// Es la parte más importante del Search Layer y la razón es una regla
// dura del dominio: SI-015 y SI-024 exigen que ninguna interpretación se
// entregue sin los mensajes originales que la sostienen.
//
// Eso está implementado como INVARIANTE DE LA FUNCIÓN, no como algo que
// el caller deba acordarse de hacer: no existe una función que devuelva
// el Event, el Insight o el Analysis por separado. Cada consulta devuelve
// un paquete que ya incluye su evidencia, y si no hay evidencia devuelve
// `null` en vez de la interpretación sola. Un caller distraído no puede
// producir una respuesta sin respaldo, porque el tipo no se lo permite.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  analyses,
  eventMessages,
  events,
  insights,
  messages,
  observations,
} from "../../infrastructure/db/schema.js";

/** Un mensaje tal como se persistió: evidencia, nunca una reelaboración. */
export interface EvidenceMessage {
  id: string;
  sentAt: Date;
  participantId: string;
  content: string;
  kind: string;
}

export interface EventWithEvidence {
  event: { id: string; caseId: string; type: string; occurredAt: Date };
  /** Nunca vacío: un Event sin evidencia viola SI-014 y no se devuelve. */
  evidence: EvidenceMessage[];
  observations: { statement: string; model: string; generatedAt: Date }[];
}

export interface InsightWithEvidence {
  insight: { id: string; caseId: string; statement: string; confidence: number };
  /** Mensajes que respaldan los Events de los que se derivó el Insight. */
  evidence: EvidenceMessage[];
  derivedFromEventIds: string[];
}

export interface AnalysisWithEvidence {
  analysis: {
    id: string;
    subjectType: string;
    subjectId: string;
    dimension: string;
    score: number;
    confidence: number;
    model: string;
    promptVersion: string;
    generatedAt: Date;
  };
  evidence: EvidenceMessage[];
}

async function messagesByIds(
  db: Database,
  ids: readonly string[]
): Promise<EvidenceMessage[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: messages.id,
      sentAt: messages.sentAt,
      participantId: messages.participantId,
      content: messages.content,
      kind: messages.kind,
    })
    .from(messages)
    .where(inArray(messages.id, [...ids]))
    .orderBy(asc(messages.sentAt), asc(messages.id));
}

async function evidenceForEventIds(
  db: Database,
  eventIds: readonly string[]
): Promise<EvidenceMessage[]> {
  if (eventIds.length === 0) return [];
  const links = await db
    .select({ messageId: eventMessages.messageId })
    .from(eventMessages)
    .where(inArray(eventMessages.eventId, [...eventIds]));
  return messagesByIds(db, [...new Set(links.map((l) => l.messageId))]);
}

/**
 * Q-EV-02 — Evidencia detrás de un Event (UC-013).
 *
 * Devuelve `null` si el Event no existe **o si no tiene evidencia**. Lo
 * segundo no debería poder pasar (SI-014 se aplica al persistir), pero si
 * pasara, devolver el Event solo sería exactamente lo que SI-015 prohíbe.
 */
export async function findEvidenceForEvent(
  eventId: string,
  db: Database = defaultDb
): Promise<EventWithEvidence | null> {
  const [event] = await db
    .select({
      id: events.id,
      caseId: events.caseId,
      type: events.type,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) return null;

  const evidence = await evidenceForEventIds(db, [eventId]);
  if (evidence.length === 0) return null;

  const obs = await db
    .select({
      statement: observations.statement,
      model: observations.model,
      generatedAt: observations.generatedAt,
    })
    .from(observations)
    .where(
      and(eq(observations.subjectType, "Event"), eq(observations.subjectId, eventId))
    );

  return { event, evidence, observations: obs };
}

/**
 * Q-EV-01 — Evidencia detrás de un Insight (UC-013, UC-019).
 *
 * Recorre `insights.derived_from_event_ids` → `event_messages` →
 * `messages`. Devuelve `null` sin evidencia: un Insight es una
 * afirmación sobre la conversación, y entregarlo sin los mensajes que lo
 * sostienen lo convertiría en una opinión no verificable (SI-015/SI-024).
 */
export async function findEvidenceForInsight(
  insightId: string,
  db: Database = defaultDb
): Promise<InsightWithEvidence | null> {
  const [insight] = await db
    .select({
      id: insights.id,
      caseId: insights.caseId,
      statement: insights.statement,
      confidence: insights.confidence,
      derivedFromEventIds: insights.derivedFromEventIds,
    })
    .from(insights)
    .where(eq(insights.id, insightId));
  if (!insight) return null;

  const evidence = await evidenceForEventIds(db, insight.derivedFromEventIds);
  if (evidence.length === 0) return null;

  return {
    insight: {
      id: insight.id,
      caseId: insight.caseId,
      statement: insight.statement,
      confidence: Number(insight.confidence),
    },
    evidence,
    derivedFromEventIds: insight.derivedFromEventIds,
  };
}

/**
 * Q-EV-03 — Evidencia detrás de un Analysis (UC-019).
 *
 * `analyses` referencia a su sujeto de forma polimórfica
 * (`subject_type`/`subject_id`), así que la resolución depende del tipo:
 * un Analysis sobre un Message es su propio mensaje; sobre un Event, los
 * mensajes de ese Event. Se devuelven además `confidence` y `model`, que
 * SI-024/SI-025 exigen para poder juzgar la interpretación.
 */
export async function findEvidenceForAnalysis(
  analysisId: string,
  db: Database = defaultDb
): Promise<AnalysisWithEvidence | null> {
  const [analysis] = await db
    .select()
    .from(analyses)
    .where(eq(analyses.id, analysisId));
  if (!analysis) return null;

  let evidence: EvidenceMessage[];
  switch (analysis.subjectType) {
    case "Message":
      evidence = await messagesByIds(db, [analysis.subjectId]);
      break;
    case "Event":
      evidence = await evidenceForEventIds(db, [analysis.subjectId]);
      break;
    default:
      // Conversation y Case agregan demasiados mensajes como para
      // devolverlos enteros: quien necesite ese detalle debe pedir la
      // evidencia de los Events del Case (Q-CS-01), que sí está acotada.
      // Se devuelve null en vez de una lista vacía para no aparentar que
      // el Analysis no tiene respaldo.
      return null;
  }
  if (evidence.length === 0) return null;

  return {
    analysis: {
      id: analysis.id,
      subjectType: analysis.subjectType,
      subjectId: analysis.subjectId,
      dimension: analysis.dimension,
      score: Number(analysis.score),
      confidence: Number(analysis.confidence),
      model: analysis.model,
      promptVersion: analysis.promptVersion,
      generatedAt: analysis.generatedAt,
    },
    evidence,
  };
}
