// Semantic Search — Q-SEM-01 de docs/QUERY_CATALOG.md. Cierra la mitad
// "Message" de UC-005.
//
// SI-036: el resultado NUNCA sustituye a Exact Search (Q-EX-*) — si la
// consulta del usuario es literal (fecha, texto exacto, participante), el
// intent debe resolverse con Exact Search aunque esto también pudiera
// responder (decisión del Agent Layer, fase 06 — fuera de esta fase).
// SI-037: toda fila devuelve su `messageId` de origen, nunca solo el score.
//
// Q-SEM-02 (Cases relacionados semánticamente) queda deferred: requiere
// embeddings con `subject_type = 'Case'`, que esta fase todavía no genera
// (plans/ solo cubre Message). Cuando una fase
// futura genere embeddings de Case, se replica el mismo patrón de
// `findSimilarMessages` filtrando `cases` en vez de `messages`.
//
// --- Ventana embebida + deduplicación (docs/DECISIONS.md, "Pendiente
// para fase 06: la ventana embebida no viaja con el resultado") ---
//
// El vector de `embeddings` representa una VENTANA (mensaje ancla + hasta
// CONTEXT_WINDOW_SIZE mensajes previos del mismo hilo,
// src/analysis/domain/embedding-chunking.ts), no el mensaje ancla aislado.
// Comprobado sobre el corpus real: un mensaje "Listo" de 5 caracteres
// entró top-5 de una consulta con score 0,567 porque sus 2 mensajes
// previos —que también aparecían como resultados propios en el mismo
// top-5— le daban esa señal. Devolver solo `content` del ancla es
// evidencia que no sostiene lo que aparenta, y una sola ventana solapada
// puede consumir varios lugares del top-k sin aportar información nueva.
//
// Esta capa de consulta (sin re-embeber ni tocar el chunking) hace dos
// cosas antes de devolver resultados:
//   1. Reconstruye la misma ventana que se embebió, con
//      `findPrecedingMessages` (infra/db/preceding-messages.ts — la MISMA
//      función que usa Embedding Generation, no una reimplementación que
//      pudiera divergir) + `buildEmbeddingChunkText`.
//   2. Deduplica candidatos cuya ventana comparte al menos un `messageId`
//      con la de un resultado ya elegido (mismo intercambio), quedándose
//      con el de mayor score como representante del grupo — `rows` ya
//      viene ordenado por similitud, así que el primero visto de cada
//      grupo es siempre el de mayor score.
//   3. Etiqueta a los hablantes de forma ESTABLE en toda la Conversation
//      (infrastructure/db/speaker-labels.ts), no por orden de aparición
//      dentro de cada ventana. Es lo que permite componer varias ventanas
//      en un mismo prompt sin que "Participante 1" cambie de persona a
//      mitad de camino — ver `windowContent`.

import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import type { EmbeddingBatchProvider } from "../../infrastructure/ai/provider.js";
import { embeddings, messages } from "../../infrastructure/db/schema.js";
import { findPrecedingMessages } from "../../infrastructure/db/preceding-messages.js";
import {
  buildConversationSpeakerLabels,
  labelFor,
  type SpeakerLabels,
} from "../../infrastructure/db/speaker-labels.js";
import { CONTEXT_WINDOW_SIZE } from "../../analysis/domain/embedding-chunking.js";

/**
 * Extremo bajo del rango 3-5 (rag-retrieval, docs/DECISIONS.md), bajado
 * de 5 a 3 al pasar de "mensaje suelto" a "ventana completa por
 * resultado": con deduplicación cada resultado ya es una ventana
 * genuinamente distinta (no un anchor redundante), pero también ~3x más
 * cara en tokens que un mensaje aislado. 3 resultados distintos cubren un
 * presupuesto de contexto similar al que tenían 5 anchors sin deduplicar
 * (validado sobre el corpus real, docs/DECISIONS.md).
 */
export const DEFAULT_SEMANTIC_TOP_K = 3;

/**
 * Cuántos candidatos por similitud se traen de la base ANTES de
 * deduplicar, como múltiplo de `topK`. Tiene que ser mayor a 1 porque una
 * sola ventana solapada puede ocupar varias posiciones consecutivas del
 * ranking bruto (hasta CONTEXT_WINDOW_SIZE + 1 candidatos por ventana en
 * el peor caso). Tope absoluto para no convertir una consulta puntual en
 * un escaneo grande de `embeddings` si la deduplicación no converge.
 */
const CANDIDATE_POOL_MULTIPLIER = 6;
const MAX_CANDIDATE_POOL = 60;

export interface SemanticSearchResult {
  /** SI-037: siempre presente — el mensaje ancla, el que efectivamente tiene el vector que matcheó. */
  messageId: string;
  /** Contenido del mensaje ancla únicamente (compatibilidad con quien solo necesite el mensaje puntual). */
  content: string;
  sentAt: Date;
  /** Similitud coseno en [-1, 1] (1 = idéntico). Mayor = más parecido. */
  score: number;
  /**
   * IDs de los hasta CONTEXT_WINDOW_SIZE mensajes de contexto que se
   * embebieron junto al ancla, en orden cronológico ascendente, SIN
   * incluir al ancla. Vacío si el ancla no tenía mensajes previos en el
   * hilo. Evidencia adicional para SI-037: es lo que justifica el score
   * cuando `content` por sí solo (ej. "Listo") no lo hace.
   */
  contextMessageIds: string[];
  /**
   * La ventana completa en orden cronológico (contexto + ancla al final),
   * estructurada. Es la forma preferida de armar contexto para un prompt:
   * cada mensaje trae su `participantId` real, así que el caller puede
   * atribuir sin depender de cómo esté formateado el texto.
   */
  windowMessages: SemanticSearchWindowMessage[];
  /**
   * Texto plano de la ventana — lo que el caller (fase 06) debe pasarle al
   * LLM como contexto, en vez de `content` a solas.
   *
   * Ojo con una diferencia deliberada: las etiquetas de hablante acá son
   * estables en toda la Conversation, mientras que el texto que se EMBEBIÓ
   * las numeraba por orden de aparición dentro de cada ventana
   * (`buildEmbeddingChunkText`). O sea que esto no es byte a byte el texto
   * vectorizado. Es a propósito: con etiquetas locales a la ventana,
   * "Participante 1" significa personas distintas en dos resultados de la
   * misma búsqueda (comprobado sobre el corpus real), y concatenarlos en un
   * prompt haría que el LLM atribuyera frases a quien no las dijo. La
   * numeración es un placeholder sin carga semántica, así que estabilizarla
   * no cambia lo que la ventana dice — solo la vuelve segura de componer.
   */
  windowContent: string;
}

export interface SemanticSearchWindowMessage {
  messageId: string;
  /** Identidad real, para resolver contra `participants` localmente si hay que mostrarla. */
  participantId: string;
  /** Etiqueta neutral estable en toda la Conversation (nunca el nombre real — rules/security-privacy.md). */
  speakerLabel: string;
  sentAt: Date;
  content: string;
  /** `true` en el mensaje ancla (el que tiene el vector que matcheó); `false` en los de contexto. */
  isAnchor: boolean;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** `<=>` (pgvector) devuelve DISTANCIA coseno; se crea de nuevo en cada uso para no compartir el mismo objeto SQL entre cláusulas. */
function cosineDistance(queryLiteral: string) {
  return sql<number>`${embeddings.vector} <=> ${queryLiteral}::vector`;
}

/** IDs que componen la ventana de un candidato (ancla + su contexto), para la comparación de solapamiento. */
function windowIds(anchorId: string, context: readonly { id: string }[]): Set<string> {
  return new Set([...context.map((m) => m.id), anchorId]);
}

/** Mismo formato de línea que `buildEmbeddingChunkText`, pero con etiquetas estables (ver `windowContent`). */
function renderWindow(window: readonly SemanticSearchWindowMessage[]): string {
  return window.map((m) => `${m.speakerLabel}: ${m.content}`).join("\n");
}

function buildWindow(
  anchor: { messageId: string; participantId: string; content: string; sentAt: Date },
  context: readonly { id: string; participantId: string; content: string; sentAt: Date }[],
  labels: SpeakerLabels
): SemanticSearchWindowMessage[] {
  const contextMessages = context.map((m) => ({
    messageId: m.id,
    participantId: m.participantId,
    speakerLabel: labelFor(labels, m.participantId),
    sentAt: m.sentAt,
    content: m.content,
    isAnchor: false,
  }));
  return [
    ...contextMessages,
    {
      messageId: anchor.messageId,
      participantId: anchor.participantId,
      speakerLabel: labelFor(labels, anchor.participantId),
      sentAt: anchor.sentAt,
      content: anchor.content,
      isAnchor: true,
    },
  ];
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const id of a) {
    if (b.has(id)) return true;
  }
  return false;
}

/**
 * Q-SEM-01 (nivel bajo): dado un vector de consulta YA EMBEBIDO, los
 * mensajes más similares de una Conversation, con su ventana completa y
 * deduplicados por solapamiento (ver comentario de cabecera). Separada de
 * `searchMessagesBySemanticSimilarity` para poder testear la consulta SQL
 * con vectores fijos, sin depender de Voyage (rules/ai-cost.md).
 *
 * Filtra por `model`/`dims` además de `subject_type = 'Message'`: cuando
 * conviven embeddings de más de una generación en la tabla (SI-028,
 * "nunca UPDATE, fila nueva"), el filtro decide cuál es la vigente — el
 * caller pasa el `model`/`dims` de `config.embeddingModel`/
 * `config.embeddingDimensions` (docs/DECISIONS.md).
 */
export async function findSimilarMessages(
  input: {
    conversationId: string;
    queryVector: readonly number[];
    model: string;
    dims: number;
    topK?: number;
  },
  db: Database = defaultDb
): Promise<SemanticSearchResult[]> {
  const topK = input.topK ?? DEFAULT_SEMANTIC_TOP_K;
  const candidateLimit = Math.min(topK * CANDIDATE_POOL_MULTIPLIER, MAX_CANDIDATE_POOL);
  const queryLiteral = toVectorLiteral(input.queryVector);

  const rows = await db
    .select({
      messageId: messages.id,
      content: messages.content,
      participantId: messages.participantId,
      sentAt: messages.sentAt,
      distance: cosineDistance(queryLiteral),
    })
    .from(embeddings)
    .innerJoin(messages, eq(messages.id, embeddings.subjectId))
    .where(
      and(
        eq(embeddings.subjectType, "Message"),
        eq(embeddings.model, input.model),
        eq(embeddings.dims, input.dims),
        eq(messages.conversationId, input.conversationId)
      )
    )
    .orderBy(asc(cosineDistance(queryLiteral)))
    .limit(candidateLimit);

  // Una sola vez por búsqueda, no una por ventana: las etiquetas deben ser
  // las mismas en todos los resultados para poder componerlos en un prompt.
  const labels = await buildConversationSpeakerLabels(input.conversationId, db);

  const selected: Array<{ result: SemanticSearchResult; ids: Set<string> }> = [];

  for (const row of rows) {
    if (selected.length >= topK) break;

    const context = await findPrecedingMessages(
      {
        conversationId: input.conversationId,
        beforeSentAt: row.sentAt,
        beforeId: row.messageId,
        count: CONTEXT_WINDOW_SIZE,
      },
      db
    );
    const ids = windowIds(row.messageId, context);

    // Mismo intercambio que un resultado ya elegido (con mayor o igual
    // score, porque `rows` viene ordenado por similitud) no suma
    // presupuesto nuevo al top-k.
    if (selected.some((s) => overlaps(s.ids, ids))) continue;

    const windowMessages = buildWindow(row, context, labels);

    selected.push({
      ids,
      result: {
        messageId: row.messageId,
        content: row.content,
        sentAt: row.sentAt,
        score: 1 - Number(row.distance),
        contextMessageIds: context.map((m) => m.id),
        windowMessages,
        windowContent: renderWindow(windowMessages),
      },
    });
  }

  return selected.map((s) => s.result);
}

/**
 * Q-SEM-01 (nivel alto): embebe `queryText` con `inputType: "query"`
 * (docs/DECISIONS.md — la asimetría document/query de Voyage mejora el
 * ranking medible; usar "document" acá degradaría la búsqueda en
 * silencio) y delega en `findSimilarMessages`.
 */
export async function searchMessagesBySemanticSimilarity(
  input: {
    conversationId: string;
    queryText: string;
    model: string;
    dims: number;
    topK?: number;
  },
  deps: { embeddingProvider: EmbeddingBatchProvider },
  db: Database = defaultDb
): Promise<SemanticSearchResult[]> {
  const [queryVector] = await deps.embeddingProvider.embedBatch([input.queryText], {
    model: input.model,
    dimensions: input.dims,
    inputType: "query",
  });
  if (!queryVector) return [];

  return findSimilarMessages(
    {
      conversationId: input.conversationId,
      queryVector,
      model: input.model,
      dims: input.dims,
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
    },
    db
  );
}
