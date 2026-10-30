// Pipeline 12 - Query Processing completo (docs/PIPELINES.md), UC-014
// (responder preguntas) y UC-019 (explicar una respuesta).
//
// Intent Detection → Query Planning → Evidence Retrieval → Context
// Assembly → LLM → Evidence Validation → Response.
//
// SI-041: el Agent Layer nunca construye SQL ni decide tablas. Traduce el
// intent a llamadas de funciones catalogadas del Search Layer, y nada
// más. Si una pregunta no se puede expresar con esas funciones, la
// respuesta es "no puedo responder" — no un SQL improvisado.
//
// SI-039/SI-040: esta fase solo responde. No envía nada ni ejecuta
// ninguna acción externa.

import type {
  AIProvider,
  EmbeddingBatchProvider,
  TokenUsage,
} from "../../infrastructure/ai/provider.js";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  countMessagesByText,
  findMessagesByDate,
  findMessagesByDateRange,
  findMessagesByText,
} from "../../search/queries/exact-search.js";
import { findEventsInRange } from "../../search/queries/timeline-search.js";
import { findAllCases, findCaseDetail } from "../../search/queries/case-search.js";
import { searchMessagesBySemanticSimilarity } from "../../search/queries/semantic-search.js";
import { getConversationStatistics } from "../../search/queries/statistics.js";
import type { DomainProfile } from "../../shared/domain-profile.js";
import {
  ANSWER_JSON_SCHEMA,
  buildAnswerPrompt,
  parseAnswerResponse,
  validateClaims,
  type ContextItem,
  type ValidatedClaim,
} from "../domain/answer-generation.js";
import {
  INTENT_DETECTION_JSON_SCHEMA,
  buildIntentDetectionPrompt,
  parseIntentDetectionResponse,
  type DetectedIntent,
} from "../domain/intent-detection.js";

export interface AnswerQuestionDeps {
  aiProvider: AIProvider;
  /** Contexto, categorías y ejemplos del dominio (shared/domain-profile.ts). */
  profile: DomainProfile;
  db?: Database;
  onUsage?: (usage: TokenUsage) => void;
  /** Inyectable para que los tests no dependan de la fecha real. */
  now?: () => Date;
  /**
   * Necesario únicamente para resolver el intent "buscar_por_tema"
   * (Semantic Search, Q-SEM-01, skill rag-retrieval). Sin esto, una
   * pregunta que resuelva a ese intent falla explícito en vez de
   * responder sin evidencia — mismo criterio que
   * `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` en `cli-embed.ts`: sin
   * default silencioso.
   */
  semanticSearch?: {
    embeddingProvider: EmbeddingBatchProvider;
    model: string;
    dims: number;
  };
}

export interface AnswerQuestionInput {
  conversationId: string;
  question: string;
  /** Máximo de elementos de evidencia que se le pasan al modelo. */
  maxContextItems?: number;
}

export interface AnsweredQuestion {
  question: string;
  intent: DetectedIntent;
  answer: string;
  /**
   * true solo si el modelo declaró evidencia suficiente Y toda afirmación
   * cita evidencia real. Una respuesta con `verified: false` no debe
   * presentarse como un hecho establecido.
   */
  verified: boolean;
  /** Afirmaciones con su evidencia resuelta — es también la salida de UC-019. */
  claims: ValidatedClaim[];
  /** Evidencia entregada al modelo, para poder reconstruir la respuesta (SI-037). */
  context: ContextItem[];
  /** true si alguna consulta devolvió resultados recortados por el tope. */
  evidenceTruncated: boolean;
}

const DEFAULT_MAX_CONTEXT_ITEMS = 40;

/** Rango por defecto cuando el intent pide cronología sin acotar fechas. */
const DEFAULT_TIMELINE_YEARS = 5;

function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Query Planning + Evidence Retrieval: traduce el intent a llamadas del
 * Search Layer. Cada rama usa exclusivamente funciones catalogadas
 * (docs/QUERY_CATALOG.md); no hay SQL acá (SI-041).
 */
async function retrieveContext(
  intent: DetectedIntent,
  input: AnswerQuestionInput,
  db: Database,
  now: Date,
  semanticSearch: AnswerQuestionDeps["semanticSearch"]
): Promise<{ context: ContextItem[]; truncated: boolean; note: string | null }> {
  const conversationId = input.conversationId;
  const limit = input.maxContextItems ?? DEFAULT_MAX_CONTEXT_ITEMS;
  const items: ContextItem[] = [];
  let truncated = false;
  let note: string | null = null;

  const pushMessages = (
    page: { items: { id: string; sentAt: Date; content: string; participantId: string }[]; truncated: boolean }
  ): void => {
    truncated = truncated || page.truncated;
    for (const message of page.items) {
      items.push({
        index: items.length + 1,
        sourceType: "Message",
        sourceId: message.id,
        sentAt: message.sentAt,
        // Etiqueta neutral: el modelo no necesita el nombre real para
        // responder, y la atribución sale de la evidencia
        // (rules/security-privacy.md).
        speakerLabel: null,
        text: message.content,
      });
    }
  };

  switch (intent.intent) {
    case "buscar_por_texto": {
      if (!intent.text) break;
      const page = await findMessagesByText(
        { conversationId, text: intent.text, limit },
        db
      );
      pushMessages(page);
      // El conteo sale de la base, no de la longitud de la lista: la
      // lista está acotada y contarla daría un número falso.
      const total = await countMessagesByText({ conversationId, text: intent.text }, db);
      note = `Coincidencias totales en la conversación: ${total}. Se muestran ${page.items.length}.`;
      break;
    }

    case "buscar_por_fecha": {
      if (!intent.date) break;
      pushMessages(
        await findMessagesByDate({ conversationId, date: isoToDate(intent.date), limit }, db)
      );
      break;
    }

    case "buscar_por_rango": {
      if (!intent.from || !intent.to) break;
      pushMessages(
        await findMessagesByDateRange(
          {
            conversationId,
            from: isoToDate(intent.from),
            // Fin inclusivo desde el punto de vista del usuario: "hasta
            // el 20" incluye el día 20 entero.
            to: new Date(isoToDate(intent.to).getTime() + 86_400_000),
            limit,
          },
          db
        )
      );
      break;
    }

    case "cronologia": {
      const from = intent.from
        ? isoToDate(intent.from)
        : new Date(
            Date.UTC(now.getUTCFullYear() - DEFAULT_TIMELINE_YEARS, now.getUTCMonth(), now.getUTCDate())
          );
      const to = intent.to
        ? new Date(isoToDate(intent.to).getTime() + 86_400_000)
        : new Date(now.getTime() + 86_400_000);

      const page = await findEventsInRange({ conversationId, from, to, limit }, db);
      truncated = truncated || page.truncated;
      for (const event of page.items) {
        items.push({
          index: items.length + 1,
          sourceType: "Event",
          sourceId: event.id,
          sentAt: event.occurredAt,
          speakerLabel: null,
          text: `[${event.type}] ${event.caseTitle} (tema: ${event.caseCategory})`,
        });
      }
      break;
    }

    case "sobre_un_case": {
      if (!intent.text) break;
      // Se busca el Case por coincidencia de palabras en el título, con
      // las funciones catalogadas: Q-SEM-02 (búsqueda semántica de Cases)
      // sigue sin implementarse porque no se generan embeddings de Case,
      // solo de Message.
      const wanted = new Set(
        intent.text
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 2)
      );
      const all = await findAllCases(conversationId, db);
      const scored = all
        .map((c) => {
          const words = c.title
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .split(/[^a-z0-9]+/);
          const hits = words.filter((w) => wanted.has(w)).length;
          return { c, score: c.category.toLowerCase() === intent.text?.toLowerCase() ? hits + 2 : hits };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0]?.c;
      if (!best) {
        note = "No se encontró ningún tema (Case) que coincida con la consulta.";
        break;
      }
      const detail = await findCaseDetail(best.id, db);
      if (!detail) break;
      truncated = truncated || detail.timeline.truncated;
      // `findCaseDetail` no recibe tope y devuelve la cronología completa
      // del Case, así que hay que acotarla acá: sin esto esta rama era la
      // única que ignoraba `maxContextItems` (medido en la regresión del
      // 2026-08-04: 59,2 ítems de media contra un tope de 40), inflando
      // costo y diluyendo el contexto.
      const timelineItems = detail.timeline.items.slice(0, limit);
      truncated = truncated || timelineItems.length < detail.timeline.items.length;
      for (const event of timelineItems) {
        items.push({
          index: items.length + 1,
          sourceType: "Event",
          sourceId: event.id,
          sentAt: event.occurredAt,
          speakerLabel: null,
          text: `[${event.type}] ${event.caseTitle} (tema: ${event.caseCategory})`,
        });
      }
      note = `Tema encontrado: "${detail.case.title}" (${detail.case.category}), con ${detail.timeline.items.length} evento(s)${
        timelineItems.length < detail.timeline.items.length
          ? `, de los que se muestran ${timelineItems.length}`
          : ""
      }.`;
      break;
    }

    case "buscar_por_tema": {
      if (!intent.text) break;
      if (!semanticSearch) {
        throw new Error(
          "El intent 'buscar_por_tema' necesita deps.semanticSearch (embeddingProvider + model + dims) — ver AnswerQuestionDeps."
        );
      }
      const results = await searchMessagesBySemanticSimilarity(
        {
          conversationId,
          queryText: intent.text,
          model: semanticSearch.model,
          dims: semanticSearch.dims,
        },
        { embeddingProvider: semanticSearch.embeddingProvider },
        db
      );
      for (const result of results) {
        items.push({
          index: items.length + 1,
          sourceType: "Message",
          sourceId: result.messageId,
          sentAt: result.sentAt,
          // El texto ya trae etiquetas neutrales por mensaje
          // (windowContent, rag-retrieval) — no hace falta un
          // speakerLabel de nivel de ítem.
          speakerLabel: null,
          text: result.windowContent,
          // `text` acá son varios mensajes y `sentAt` es solo el del
          // ancla: sin esto, los mensajes de contexto de la ventana no se
          // pueden ubicar por fecha en la conversación original.
          windowMessages: result.windowMessages.map((m) => ({
            messageId: m.messageId,
            sentAt: m.sentAt,
          })),
        });
      }
      // Nota distinta según si hubo resultados: con 0 resultados, el texto
      // genérico de abajo describería resultados que no existen — mismo
      // criterio que "No se encontró ningún tema" en sobre_un_case.
      note =
        results.length > 0
          ? `Se muestran ${results.length} resultado(s) por similitud semántica (no búsqueda literal): pueden incluir mensajes relacionados en tema aunque no compartan las palabras exactas de la pregunta. Cada resultado es una ventana de varios mensajes consecutivos, no un mensaje aislado.`
          : "No se encontraron mensajes semánticamente similares a este tema.";
      break;
    }

    case "estadisticas": {
      const stats = await getConversationStatistics(conversationId, db);
      // La estadística entra como evidencia citable, no como nota al
      // margen. Un conteo agregado no se prueba con un mensaje concreto,
      // pero es igual de verificable: se recalcula corriendo la misma
      // consulta. Si viajara solo como nota, ninguna afirmación podría
      // citarla y toda respuesta correcta saldría marcada como no
      // respaldada.
      items.push({
        index: items.length + 1,
        sourceType: "Statistic",
        sourceId: conversationId,
        sentAt: stats.lastMessageAt ?? now,
        speakerLabel: null,
        text:
          `Estadísticas de la conversación: ${stats.messageCount} mensajes, ` +
          `${stats.eventCount} eventos, ${stats.openCaseCount} temas abiertos, ` +
          `${stats.pendingReminderCount} recordatorios pendientes. ` +
          `Reparto por participante: ` +
          stats.messagesByParticipant
            .map((p) => `${p.displayName}: ${p.messageCount}`)
            .join(", ") +
          `. Período: ${stats.firstMessageAt?.toISOString().slice(0, 10) ?? "?"} a ` +
          `${stats.lastMessageAt?.toISOString().slice(0, 10) ?? "?"}.`,
      });
      break;
    }

    case "no_soportado":
      break;
  }

  return { context: items, truncated, note };
}

const NO_ANSWER =
  "No puedo responder esa pregunta con la evidencia disponible.";

export async function answerQuestion(
  deps: AnswerQuestionDeps,
  input: AnswerQuestionInput
): Promise<AnsweredQuestion> {
  const db = deps.db ?? defaultDb;
  const now = deps.now?.() ?? new Date();
  const onUsage = deps.onUsage;

  const intentRaw = await deps.aiProvider.complete(
    buildIntentDetectionPrompt(input.question, now, deps.profile),
    {
      tier: "cheap",
      jsonSchema: INTENT_DETECTION_JSON_SCHEMA,
      maxTokens: 512,
      ...(onUsage ? { onUsage } : {}),
    }
  );
  const intent = parseIntentDetectionResponse(intentRaw);

  if (intent.intent === "no_soportado") {
    return {
      question: input.question,
      intent,
      answer: intent.reason
        ? `${NO_ANSWER} ${intent.reason}`
        : NO_ANSWER,
      verified: false,
      claims: [],
      context: [],
      evidenceTruncated: false,
    };
  }

  const { context, truncated, note } = await retrieveContext(
    intent,
    input,
    db,
    now,
    deps.semanticSearch
  );

  // Sin evidencia recuperada no se llama al modelo: no hay nada sobre lo
  // que pueda responder, y pedirle una respuesta igual es invitarlo a
  // inventarla (además de pagar una llamada para nada). La condición mira
  // solo el contexto: `note` es información de apoyo, nunca algo que se
  // pueda citar, así que su presencia no justifica una llamada.
  if (context.length === 0) {
    return {
      question: input.question,
      intent,
      answer: note ? `${NO_ANSWER} ${note}` : NO_ANSWER,
      verified: false,
      claims: [],
      context: [],
      evidenceTruncated: truncated,
    };
  }

  const questionWithNote = note
    ? `${input.question}\n\n[Contexto adicional del sistema, no es evidencia citable: ${note}${
        truncated
          ? " La evidencia mostrada está recortada: hay más resultados de los que se listan."
          : ""
      }]`
    : input.question;

  const answerRaw = await deps.aiProvider.complete(
    buildAnswerPrompt(questionWithNote, context, deps.profile),
    {
      tier: "default",
      jsonSchema: ANSWER_JSON_SCHEMA,
      // 2048 se quedaba corto con evidencia abundante: medido en la
      // regresión de 100 preguntas, una respuesta sobre 40 ítems de
      // contexto con 7 afirmaciones citadas supera ese tope y vuelve
      // truncada (docs/DECISIONS.md, 2026-08-04). La salida media es
      // ~1.300 tokens, así que 4096 deja margen real sin encarecer el
      // caso normal: max_tokens es un techo, se factura lo generado.
      maxTokens: 4096,
      ...(onUsage ? { onUsage } : {}),
    }
  );
  const generated = parseAnswerResponse(answerRaw);
  const validation = validateClaims(generated.claims, context);

  return {
    question: input.question,
    intent,
    answer: generated.answer,
    // Ambas condiciones: el modelo declaró tener evidencia suficiente Y
    // la validación determinista confirmó que cada afirmación cita
    // evidencia real. Que el modelo diga que sí no alcanza.
    verified: generated.sufficientEvidence && validation.fullySupported,
    claims: validation.claims,
    context,
    evidenceTruncated: truncated,
  };
}
