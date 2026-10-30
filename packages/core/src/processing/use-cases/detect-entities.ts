// Pipeline 4 - Entity Detection (docs/PIPELINES.md, UC-006). Primera
// etapa del Pipeline General que usa IA real (rules/ai-cost.md aplica a
// cualquier corrida contra la API real — no a los tests, que inyectan
// un AIProvider fake). Orquesta: buscar mensajes en METADATA_READY,
// pedirle al modelo las entidades (tier "cheap" — docs/DECISIONS.md),
// validar la respuesta, y persistir + avanzar el estado.

import type { AIProvider, TokenUsage } from "../../infrastructure/ai/provider.js";
import type { AuditRecorder } from "../../shared/audit.js";
import type { DomainProfile } from "../../shared/domain-profile.js";
import {
  ENTITY_DETECTION_JSON_SCHEMA,
  buildEntityDetectionPrompt,
  parseEntityDetectionResponse,
  type DetectedEntity,
  type EntityDetectionBatchItem,
} from "../domain/entity-detection.js";
import type {
  MessageForEntityDetection,
  ProcessingRepository,
} from "../repositories/processing-repository.js";

export interface DetectEntitiesDeps {
  processingRepo: ProcessingRepository;
  aiProvider: AIProvider;
  audit: AuditRecorder;
  /** Solo aporta el contexto de la conversación al prompt (shared/domain-profile.ts). */
  profile: DomainProfile;
  /** Tokens consumidos por cada llamada, para reportar el costo real de la corrida (rules/ai-cost.md regla 5). */
  onUsage?: (usage: TokenUsage) => void;
}

export interface DetectEntitiesInput {
  conversationId: string;
  /** Tamaño de lote de LECTURA de la base — evita cargar toda la conversación en memoria. */
  batchSize?: number;
  /**
   * Cuántos mensajes se analizan por llamada a la IA. Es la palanca de
   * costo: con mensajes cortos, una llamada por mensaje gasta la mayor
   * parte de los tokens de entrada repitiendo las instrucciones. Subirlo
   * abarata, pero agranda el radio de daño de una respuesta malformada
   * (se pierde el grupo entero, no un mensaje) y exige más tokens de
   * salida por llamada.
   */
  aiBatchSize?: number;
  /**
   * Corta la corrida después de procesar esta cantidad de mensajes.
   * Existe para poder validar en pequeño antes de lanzar el backlog
   * completo: una corrida acotada muestra la tasa real de fallos y el
   * costo por mensaje observado sin comprometer el presupuesto entero
   * (`rules/ai-cost.md`). Sin límite por defecto.
   */
  maxMessages?: number;
}

export interface DetectEntitiesResult {
  messagesProcessed: number;
  /** Mensajes cuya respuesta de IA no se pudo validar (docs/SECURITY.md, "Dependencias Externas") — no bloquean el resto del lote. */
  messagesFailed: number;
  /** Llamadas reales a la IA. Sirve para contrastar el costo estimado contra el observado (rules/ai-cost.md regla 5). */
  aiCalls: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_AI_BATCH_SIZE = 25;

/**
 * Presupuesto de salida por llamada. La salida es JSON estructurado cuyo
 * tamaño crece con la cantidad de mensajes del grupo; quedarse corto
 * trunca la respuesta y hace fallar el grupo entero DESPUÉS de haberlo
 * pagado.
 */
const OUTPUT_TOKENS_BASE = 512;
const OUTPUT_TOKENS_PER_MESSAGE = 150;

function chunk<T>(items: readonly T[], size: number): T[][] {
  // Con size <= 0 el bucle no avanzaría y colgaría el proceso llenando
  // memoria en silencio — un cuelgue dentro del pipeline que gasta saldo
  // es justo lo que rules/ai-cost.md pide evitar. Se falla de entrada.
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`aiBatchSize debe ser un entero positivo, recibido: ${size}.`);
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/** UC interno de Pipeline 4 — no tiene UC-xxx propio en docs/USE_CASES.md (UC-006 es el resultado, no este orquestador). */
export async function detectEntitiesForConversation(
  deps: DetectEntitiesDeps,
  input: DetectEntitiesInput
): Promise<DetectEntitiesResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const aiBatchSize = input.aiBatchSize ?? DEFAULT_AI_BATCH_SIZE;
  // Se valida acá y no solo dentro de chunk() para fallar antes de tocar
  // la base de datos, no a mitad de la corrida.
  if (!Number.isInteger(aiBatchSize) || aiBatchSize <= 0) {
    throw new Error(
      `aiBatchSize debe ser un entero positivo, recibido: ${aiBatchSize}.`
    );
  }

  // Mensajes que fallaron la validación en ESTA corrida: quedan en
  // METADATA_READY a propósito (para reintentarse en una corrida
  // futura, PL-003), pero por eso mismo el repositorio los vuelve a
  // devolver como "pendientes" en la siguiente vuelta del loop de abajo
  // — sin este filtro, un mensaje que falla sistemáticamente se
  // reintentaría contra la IA en cada iteración del batch dentro de la
  // MISMA corrida, sin límite, si hay >= batchSize mensajes fallando a
  // la vez (loop que nunca cumple "pending.length < batchSize"). Ver
  // rules/ai-cost.md — esto es exactamente el "reproceso" que esa regla
  // pide evitar.
  const failedThisRun = new Set<string>();

  let messagesProcessed = 0;
  let messagesFailed = 0;
  let aiCalls = 0;

  const markFailed = async (messageId: string, reason: string): Promise<void> => {
    failedThisRun.add(messageId);
    messagesFailed += 1;
    await deps.audit({
      actor: "DetectEntitiesForConversation",
      operation: "entity_detection",
      resourceType: "Message",
      resourceId: messageId,
      result: "failure",
      details: { errorSummary: reason },
    });
  };

  for (;;) {
    const fetched = await deps.processingRepo.findMessagesPendingEntityDetection(
      input.conversationId,
      batchSize
    );
    const unfiltered = fetched.filter((m) => !failedThisRun.has(m.id));
    // pending.length === 0 cubre tanto "no queda nada" como "lo único
    // que queda ya falló antes en esta corrida" — ambos casos deben
    // cortar el loop, no solo el primero.
    if (unfiltered.length === 0) break;

    const remaining =
      input.maxMessages === undefined
        ? unfiltered.length
        : input.maxMessages - (messagesProcessed + messagesFailed);
    if (remaining <= 0) break;
    const pending = unfiltered.slice(0, remaining);

    // kind != 'text' (llamada/sistema) no tiene contenido de un
    // participante que analizar — mismo criterio que Metadata
    // Extraction: se marca ENTITY_READY sin entidades, no se manda a
    // IA (ahorra una llamada real por cada mensaje que no aplica).
    const analyzable: MessageForEntityDetection[] = [];
    for (const message of pending) {
      if (message.kind !== "text") {
        await deps.processingRepo.recordEntityDetection(message.id, []);
        messagesProcessed += 1;
      } else {
        analyzable.push(message);
      }
    }

    for (const group of chunk(analyzable, aiBatchSize)) {
      // El índice es la posición dentro de ESTE grupo, no un id del
      // sistema: no hace falta exponerle UUIDs internos al modelo, y
      // gasta muchos menos tokens.
      const items: EntityDetectionBatchItem[] = group.map((message, i) => ({
        index: i + 1,
        content: message.content,
      }));

      // La llamada al proveedor NO se envuelve en el catch de abajo: un
      // fallo acá (credencial inválida, sin saldo — ver
      // rules/ai-cost.md — rate limit, red caída) es sistémico, no un
      // problema de ESTE grupo. Si se tratara como fallo individual,
      // una cuenta sin saldo produciría miles de "fallos" silenciosos
      // en vez de frenar la corrida de inmediato (exactamente el
      // escenario ya documentado en docs/DECISIONS.md, fase 01).
      const raw = await deps.aiProvider.complete(
        buildEntityDetectionPrompt(items, deps.profile),
        {
          tier: "cheap",
          jsonSchema: ENTITY_DETECTION_JSON_SCHEMA,
          maxTokens: OUTPUT_TOKENS_BASE + OUTPUT_TOKENS_PER_MESSAGE * items.length,
          ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
        }
      );
      aiCalls += 1;

      let byIndex: Map<number, DetectedEntity[]>;
      try {
        // Acá sí se aísla: una respuesta que no matchea el esquema
        // esperado no bloquea el resto de los grupos (SI-034) ni pierde
        // lo ya procesado. El radio de daño es el grupo, no la corrida.
        byIndex = parseEntityDetectionResponse(
          raw,
          items.map((item) => item.index)
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const message of group) {
          await markFailed(message.id, reason);
        }
        continue;
      }

      for (const [i, message] of group.entries()) {
        const entities = byIndex.get(i + 1);
        if (entities === undefined) {
          // El modelo no devolvió entrada para este mensaje. NO se
          // asume "sin entidades": eso marcaría ENTITY_READY un mensaje
          // que nunca se analizó, y como el estado no vuelve atrás
          // (PL-004) quedaría con entidades vacías para siempre sin que
          // nadie lo note. Se deja pendiente para una corrida futura.
          await markFailed(
            message.id,
            "El modelo no devolvió resultado para este mensaje dentro del lote."
          );
          continue;
        }
        await deps.processingRepo.recordEntityDetection(message.id, entities);
        messagesProcessed += 1;
      }
    }

    // Se compara contra fetched (lo que devolvió la DB), no contra
    // pending (ya filtrado) — un batch lleno de fetched con algunos
    // filtrados por failedThisRun todavía puede tener más pendientes
    // reales detrás.
    if (fetched.length < batchSize) break;
  }

  await deps.audit({
    actor: "DetectEntitiesForConversation",
    operation: "entity_detection",
    resourceType: "Conversation",
    resourceId: input.conversationId,
    result: "success",
    details: { messagesProcessed, messagesFailed, aiCalls },
  });

  return { messagesProcessed, messagesFailed, aiCalls };
}
