// Pipelines 5 y 6 - Event Detection (UC-007) + Case Resolution (UC-008).
//
// Van juntos por una razón de dominio, no de conveniencia:
// docs/AGGREGATES.md define Event como entidad interna del agregado Case
// ("Todo Event pertenece a un único Case", y un EventRepository está
// explícitamente prohibido). No existe un estado intermedio válido donde
// un Event esté persistido sin su Case, así que separarlos en dos
// escrituras exigiría o bien debilitar el invariante, o bien perder el
// trabajo de la etapa 5 si la 6 no llega a correr.
//
// La detección usa IA (tier "default"); la resolución del Case es
// determinista y no gasta una segunda llamada.

import type { AIProvider, TokenUsage } from "../../infrastructure/ai/provider.js";
import type { AuditRecorder } from "../../shared/audit.js";
import { withProfileVersion, type DomainProfile } from "../../shared/domain-profile.js";
import { resolveCase, type OpenCaseSummary } from "../domain/case-resolution.js";
import {
  buildEventDetectionJsonSchema,
  buildEventDetectionPrompt,
  parseEventDetectionResponse,
  type CaseCategory,
  type EventDetectionWindowItem,
} from "../domain/event-detection.js";
import type {
  CaseRepository,
  EventToPersist,
  MessageForEventDetection,
} from "../repositories/case-repository.js";

export interface DetectEventsDeps {
  caseRepo: CaseRepository;
  aiProvider: AIProvider;
  audit: AuditRecorder;
  /** Categorías, dimensiones y contexto del dominio (shared/domain-profile.ts). */
  profile: DomainProfile;
  onUsage?: (usage: TokenUsage) => void;
}

export interface DetectEventsInput {
  conversationId: string;
  /** Tamaño de lote de LECTURA de la base. */
  batchSize?: number;
  /** Mensajes por ventana de análisis (una llamada a la IA por ventana). */
  windowSize?: number;
  /** Corta la corrida tras procesar esta cantidad de mensajes — control de gasto. */
  maxMessages?: number;
  /**
   * Razonamiento del modelo. Por defecto apagado para acotar costo; se
   * puede subir a "adaptive" en las ventanas donde la calidad de la
   * clasificación importe más que el gasto (docs/DECISIONS.md priorizó
   * calidad en esta etapa, pero el backlog completo con razonamiento
   * excede el presupuesto disponible — ver rules/ai-cost.md).
   */
  thinking?: "disabled" | "adaptive";
}

export interface DetectEventsResult {
  messagesProcessed: number;
  /** Mensajes de ventanas cuya respuesta de IA no se pudo validar — quedan pendientes. */
  messagesFailed: number;
  eventsDetected: number;
  casesCreated: number;
  aiCalls: number;
}

const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_WINDOW_SIZE = 20;

/**
 * Versión del prompt de esta etapa. Se persiste en `analyses.prompt_version`
 * (SI-020): sin esto no se puede saber qué interpretación produjo qué
 * versión del prompt cuando se reprocese (UC-020).
 *
 * El perfil de dominio cambia el prompt, así que va incluido
 * (`<base>+<perfil>@<versión>`, ver `withProfileVersion`).
 */
export const EVENT_DETECTION_PROMPT_BASE_VERSION = "event-detection-v2";

const OUTPUT_TOKENS_BASE = 1024;
const OUTPUT_TOKENS_PER_MESSAGE = 200;

/**
 * Prefijo de los ids sintéticos que se usan para los Cases decididos
 * dentro de una ventana que todavía no se persistió. Nunca llega a la
 * base: sirve solo para que los eventos siguientes de la misma ventana
 * puedan agruparse con un Case que aún no tiene id real.
 */
const PENDING_CASE_PREFIX = "pendiente:";

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`windowSize debe ser un entero positivo, recibido: ${size}.`);
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/**
 * Etiquetas neutrales y estables dentro de una ventana. No se manda el
 * nombre real del participante al modelo: no le hace falta para
 * clasificar, y la atribución se reconstruye desde la evidencia
 * (`event_messages` → `messages.participant_id`).
 */
function speakerLabels(window: readonly MessageForEventDetection[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const message of window) {
    if (!labels.has(message.participantId)) {
      labels.set(message.participantId, `Participante ${labels.size + 1}`);
    }
  }
  return labels;
}

export async function detectEventsForConversation(
  deps: DetectEventsDeps,
  input: DetectEventsInput
): Promise<DetectEventsResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error(`windowSize debe ser un entero positivo, recibido: ${windowSize}.`);
  }

  // Mismo criterio que Entity Detection: los mensajes que fallaron en
  // ESTA corrida quedan pendientes a propósito (PL-003), pero no se
  // reintentan dentro de la misma corrida — si no, un lote que falla
  // sistemáticamente se reprocesaría sin límite contra la IA
  // (rules/ai-cost.md).
  const failedThisRun = new Set<string>();

  let messagesProcessed = 0;
  let messagesFailed = 0;
  let eventsDetected = 0;
  let casesCreated = 0;
  let aiCalls = 0;

  // El proveedor reporta qué modelo atendió cada llamada; el caso de uso
  // solo eligió un tier. Se captura acá para poder persistirlo en
  // analyses.model (SI-019) sin que el dominio tenga que conocer los
  // nombres de los modelos.
  let lastModelUsed: string | null = null;
  const onUsage = (usage: TokenUsage): void => {
    lastModelUsed = usage.model;
    deps.onUsage?.(usage);
  };

  // Los Cases abiertos se leen una vez y se mantienen en memoria: cada
  // ventana puede crear Cases que la siguiente debe poder reutilizar, y
  // releer la tabla por ventana sería una consulta por llamada de IA.
  const openCases: OpenCaseSummary[] = await deps.caseRepo.findOpenCases(
    input.conversationId
  );

  for (;;) {
    const fetched = await deps.caseRepo.findMessagesPendingEventDetection(
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

    for (const window of chunk(pending, windowSize)) {
      // Cases decididos dentro de ESTA ventana que todavía no existen en
      // la base. Se vacía por ventana porque después de persistir ya
      // tienen id real y se releen desde la base.
      const pendingCases = new Map<string, { title: string; category: CaseCategory }>();
      const labels = speakerLabels(window);
      const items: EventDetectionWindowItem[] = window.map((message, i) => ({
        index: i + 1,
        speakerLabel: labels.get(message.participantId) ?? "Participante ?",
        sentAt: message.sentAt,
        content: message.content,
      }));

      // Un fallo del proveedor (sin saldo, rate limit, red) es sistémico:
      // se deja propagar y corta la corrida, en vez de marcar miles de
      // ventanas como "fallidas" en silencio.
      const raw = await deps.aiProvider.complete(buildEventDetectionPrompt(items, deps.profile), {
        tier: "default",
        jsonSchema: buildEventDetectionJsonSchema(deps.profile),
        maxTokens: OUTPUT_TOKENS_BASE + OUTPUT_TOKENS_PER_MESSAGE * items.length,
        ...(input.thinking ? { thinking: input.thinking } : {}),
        onUsage,
      });
      aiCalls += 1;

      let detected;
      try {
        detected = parseEventDetectionResponse(
          raw,
          items.map((item) => item.index),
          deps.profile
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const message of window) {
          failedThisRun.add(message.id);
          messagesFailed += 1;
          await deps.audit({
            actor: "DetectEventsForConversation",
            operation: "event_detection",
            resourceType: "Message",
            resourceId: message.id,
            result: "failure",
            details: { errorSummary: reason },
          });
        }
        continue;
      }

      const toPersist: EventToPersist[] = [];
      for (const event of detected) {
        const messageIds = event.messageIndices
          .map((index) => window[index - 1]?.id)
          .filter((id): id is string => id !== undefined);
        if (messageIds.length === 0) continue; // SI-014, defensa redundante

        // occurred_at sale de la evidencia (el sent_at del primer mensaje
        // que respalda el evento), no de lo que diga el modelo: una fecha
        // inventada contaminaría la cronología de UC-012.
        const firstIndex = event.messageIndices[0] ?? 1;
        const occurredAt = window[firstIndex - 1]?.sentAt ?? window[0]?.sentAt;
        if (!occurredAt) continue;

        const resolution = resolveCase(
          { category: event.category, title: event.title, occurredAt },
          openCases,
          deps.profile
        );

        // Un Case decidido en una ventana anterior de ESTA corrida ya
        // existe en la base con id real; uno decidido antes en ESTA misma
        // ventana todavía no. Para el segundo caso se vuelve a emitir un
        // target "new" con el mismo título y categoría: el repositorio
        // deduplica por ese par dentro de la transacción, así que ambos
        // eventos terminan en un único Case en vez de dos idénticos.
        const pendiente =
          resolution.kind === "existing"
            ? pendingCases.get(resolution.caseId)
            : undefined;
        const target: EventToPersist["target"] = pendiente
          ? { kind: "new", title: pendiente.title, category: pendiente.category }
          : resolution;

        toPersist.push({
          type: event.type,
          occurredAt,
          messageIds,
          observation: event.observation,
          confidence: event.confidence,
          analyses: event.analyses,
          target,
        });

        if (resolution.kind === "new") {
          casesCreated += 1;
          // El Case todavía no existe en la base (se crea al persistir la
          // ventana), pero los eventos siguientes de esta misma ventana
          // tienen que poder agruparse con él: una propuesta y su
          // aceptación son dos eventos del mismo asunto. Se le da un id
          // sintético, reconocible más arriba, para no confundirlo nunca
          // con un id real de la base.
          const syntheticId = `${PENDING_CASE_PREFIX}${pendingCases.size + 1}`;
          pendingCases.set(syntheticId, {
            title: resolution.title,
            category: resolution.category,
          });
          openCases.push({
            id: syntheticId,
            title: resolution.title,
            category: resolution.category,
            lastEventAt: occurredAt,
          });
        } else {
          // Asociar un Event a un Case existente lo deja "vivo": si no se
          // refleja acá, las ventanas siguientes seguirían comparando
          // contra una fecha vieja y, pasada la ventana de continuidad,
          // abrirían un duplicado del mismo asunto. Sobre un backlog de
          // meses eso fragmenta los Cases, que es justo lo que este
          // criterio busca evitar.
          const abierto = openCases.find((c) => c.id === resolution.caseId);
          if (abierto && (abierto.lastEventAt === null || abierto.lastEventAt < occurredAt)) {
            abierto.lastEventAt = occurredAt;
          }
        }
      }

      await deps.caseRepo.recordEventDetection({
        conversationId: input.conversationId,
        processedMessageIds: window.map((m) => m.id),
        events: toPersist,
        // El modelo real lo reporta el proveedor (el caso de uso elige un
        // tier, no un modelo). Se persiste en analyses.model (SI-019):
        // sin eso no se puede saber qué modelo produjo qué
        // interpretación cuando haya que reprocesar (UC-020).
        model: lastModelUsed ?? "desconocido",
        promptVersion: withProfileVersion(EVENT_DETECTION_PROMPT_BASE_VERSION, deps.profile),
      });

      eventsDetected += toPersist.length;
      messagesProcessed += window.length;

      // Los Cases creados en esta ventana ya existen en la base con su id
      // real, y las ventanas siguientes tienen que poder agruparse con
      // ellos: sin este refresco, cada ventana abriría su propio Case del
      // mismo tema y UC-011 ("consultar un Case") quedaría inservible.
      // Es una consulta barata por llamada de IA, que domina el costo.
      if (toPersist.some((e) => e.target.kind === "new")) {
        openCases.length = 0;
        openCases.push(...(await deps.caseRepo.findOpenCases(input.conversationId)));
      }
    }

    if (fetched.length < batchSize) break;
  }

  await deps.audit({
    actor: "DetectEventsForConversation",
    operation: "event_detection",
    resourceType: "Conversation",
    resourceId: input.conversationId,
    result: "success",
    details: { messagesProcessed, messagesFailed, eventsDetected, casesCreated, aiCalls },
  });

  return { messagesProcessed, messagesFailed, eventsDetected, casesCreated, aiCalls };
}
