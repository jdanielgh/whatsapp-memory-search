// Pipeline 10 - Embedding Generation (docs/PIPELINES.md, UC-005). Genera
// embeddings de Message. Event/Case/Insight/Summary quedan para cuando
// esas fases generen los suyos (plans/,
// "opcionalmente para Event/Case/Insight/Summary cuando esas entidades
// existan").
//
// rules/ai-cost.md aplica: la llamada a Voyage es real y cuesta saldo.
// Este archivo solo corrió con fakes (ver embeddings.test.ts) — la
// corrida real contra el backlog necesita confirmación explícita del
// usuario (costo aprobado), igual que Entity/Event Detection.
//
// Idempotencia (rules/ai-cost.md regla 4): solo se procesan mensajes
// pendientes (`EmbeddingsRepository.findMessagesPendingEmbedding`); una
// corrida interrumpida no repaga mensajes ya EMBEDDED.

import type {
  EmbeddingBatchProvider,
  EmbeddingUsage,
} from "../infrastructure/ai/provider.js";
import { EmbeddingValidationError } from "../infrastructure/ai/provider.js";
import type { AuditRecorder } from "../shared/audit.js";
import { buildEmbeddingChunkText, CONTEXT_WINDOW_SIZE } from "./domain/embedding-chunking.js";
import type {
  EmbeddingsRepository,
  MessageForEmbedding,
} from "./repositories/embeddings-repository.js";

export interface GenerateEmbeddingsDeps {
  embeddingsRepo: EmbeddingsRepository;
  embeddingProvider: EmbeddingBatchProvider;
  audit: AuditRecorder;
  /** Sin default silencioso: viene de config.embeddingModel/embeddingDimensions (docs/DECISIONS.md). */
  model: string;
  dimensions: number;
  /** Tokens consumidos por cada llamada, para el costo real de la corrida (rules/ai-cost.md regla 5). */
  onUsage?: (usage: EmbeddingUsage) => void;
}

export interface GenerateEmbeddingsInput {
  conversationId: string;
  /** Tamaño de lote de LECTURA de la base. */
  batchSize?: number;
  /**
   * Cuántos chunks se embeben por llamada a Voyage. Palanca de costo y de
   * riesgo de rate limit — ver VoyageEmbeddingProvider.DEFAULT_MAX_BATCH_SIZE.
   */
  aiBatchSize?: number;
  /** Corta la corrida tras procesar esta cantidad — validar en pequeño antes del backlog completo (rules/ai-cost.md). */
  maxMessages?: number;
}

export interface GenerateEmbeddingsResult {
  messagesProcessed: number;
  /** Mensajes cuyo chunk no se pudo embeber por una respuesta de Voyage con forma inesperada — no bloquean el resto del lote (SI-034). */
  messagesFailed: number;
  aiCalls: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_AI_BATCH_SIZE = 64;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  // Con size <= 0 el bucle no avanzaría y colgaría el proceso llenando
  // memoria en silencio, dentro del pipeline que gasta saldo real — se
  // falla de entrada (mismo criterio que detectEntitiesForConversation).
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`aiBatchSize debe ser un entero positivo, recibido: ${size}.`);
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/** UC interno de Pipeline 10 — no tiene UC-xxx propio en docs/USE_CASES.md (UC-005 es el resultado, no este orquestador). */
export async function generateEmbeddingsForConversation(
  deps: GenerateEmbeddingsDeps,
  input: GenerateEmbeddingsInput
): Promise<GenerateEmbeddingsResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const aiBatchSize = input.aiBatchSize ?? DEFAULT_AI_BATCH_SIZE;
  if (!Number.isInteger(aiBatchSize) || aiBatchSize <= 0) {
    throw new Error(`aiBatchSize debe ser un entero positivo, recibido: ${aiBatchSize}.`);
  }

  // Mismo motivo que detectEntitiesForConversation: sin este filtro, un
  // chunk que falla sistemáticamente se reintentaría contra Voyage en
  // cada vuelta del loop externo dentro de la MISMA corrida, sin límite,
  // si hay >= batchSize mensajes fallando a la vez.
  const failedThisRun = new Set<string>();

  let messagesProcessed = 0;
  let messagesFailed = 0;
  let aiCalls = 0;

  const markFailed = async (messageId: string, reason: string): Promise<void> => {
    failedThisRun.add(messageId);
    messagesFailed += 1;
    await deps.audit({
      actor: "GenerateEmbeddingsForConversation",
      operation: "embedding_generation",
      resourceType: "Message",
      resourceId: messageId,
      result: "failure",
      details: { errorSummary: reason },
    });
  };

  for (;;) {
    const fetched = await deps.embeddingsRepo.findMessagesPendingEmbedding(
      input.conversationId,
      batchSize
    );
    const unfiltered = fetched.filter((m) => !failedThisRun.has(m.id));
    if (unfiltered.length === 0) break;

    const remaining =
      input.maxMessages === undefined
        ? unfiltered.length
        : input.maxMessages - (messagesProcessed + messagesFailed);
    if (remaining <= 0) break;
    const pending = unfiltered.slice(0, remaining);

    // kind != 'text' (llamada/sistema) no tiene contenido semántico que
    // buscar — se marca EMBEDDED sin llamar a Voyage, ahorrando el costo.
    const analyzable: MessageForEmbedding[] = [];
    for (const message of pending) {
      if (message.kind !== "text") {
        await deps.embeddingsRepo.markEmbeddedWithoutVector(message.id);
        messagesProcessed += 1;
      } else {
        analyzable.push(message);
      }
    }

    // El texto de cada chunk se resuelve ANTES de agrupar para Voyage:
    // cada mensaje consulta sus hasta CONTEXT_WINDOW_SIZE mensajes
    // previos de forma independiente (evidencia inmutable, consulta
    // barata e indexada — docs/DECISIONS.md prioriza simplicidad acá
    // porque lo caro de la corrida es la llamada a Voyage, no el I/O
    // local a Postgres).
    const withText: Array<{ message: MessageForEmbedding; text: string }> = [];
    for (const message of analyzable) {
      const context = await deps.embeddingsRepo.findPrecedingMessages({
        conversationId: input.conversationId,
        beforeSentAt: message.sentAt,
        beforeId: message.id,
        count: CONTEXT_WINDOW_SIZE,
      });
      const text = buildEmbeddingChunkText(message, context);
      withText.push({ message, text });
    }

    for (const group of chunkArray(withText, aiBatchSize)) {
      const texts = group.map((item) => item.text);

      let vectors: number[][];
      try {
        // La llamada al proveedor NO se envuelve en un catch genérico: un
        // fallo sistémico (credencial inválida, rate limit agotado, red)
        // debe cortar la corrida entera, no tratarse como fallo de este
        // grupo (mismo criterio que detectEntitiesForConversation). Solo
        // se aísla EmbeddingValidationError (respuesta con forma
        // inesperada), que sí es un problema local de este lote.
        vectors = await deps.embeddingProvider.embedBatch(texts, {
          model: deps.model,
          dimensions: deps.dimensions,
          inputType: "document",
          ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
        });
        aiCalls += 1;
      } catch (err) {
        if (err instanceof EmbeddingValidationError) {
          aiCalls += 1;
          for (const item of group) {
            await markFailed(item.message.id, err.message);
          }
          continue;
        }
        throw err;
      }

      for (const [i, item] of group.entries()) {
        const vector = vectors[i];
        if (!vector) {
          await markFailed(
            item.message.id,
            "Voyage no devolvió vector para este mensaje dentro del lote."
          );
          continue;
        }
        await deps.embeddingsRepo.recordEmbedding({
          messageId: item.message.id,
          model: deps.model,
          dims: deps.dimensions,
          vector,
        });
        messagesProcessed += 1;
      }
    }

    if (fetched.length < batchSize) break;
  }

  await deps.audit({
    actor: "GenerateEmbeddingsForConversation",
    operation: "embedding_generation",
    resourceType: "Conversation",
    resourceId: input.conversationId,
    result: "success",
    details: { messagesProcessed, messagesFailed, aiCalls },
  });

  return { messagesProcessed, messagesFailed, aiCalls };
}
