// Repositorio del Aggregate Case (docs/AGGREGATES.md: "Existe
// exactamente un repositorio por Aggregate Root"). Event, Insight y
// Relationship son entidades internas del agregado y se administran
// exclusivamente desde acá — AGGREGATES.md prohíbe explícitamente un
// EventRepository o un InsightRepository.
//
// Esa prohibición es la razón de que Event Detection y Case Resolution
// se escriban juntas: "Todo Event pertenece a un único Case" es
// invariante del agregado (y constraint NOT NULL en events.case_id), así
// que no existe un estado intermedio válido donde un Event esté
// persistido sin su Case.

import type { OpenCaseSummary } from "../domain/case-resolution.js";
import type {
  CaseCategory,
  DetectedAnalysis,
  EventType,
} from "../domain/event-detection.js";

export interface MessageForEventDetection {
  id: string;
  content: string;
  kind: string;
  participantId: string;
  sentAt: Date;
}

/** Un Event ya resuelto: con su Case decidido y sus mensajes de respaldo. */
export interface EventToPersist {
  type: EventType;
  occurredAt: Date;
  /** Mensajes que respaldan el Event (SI-014). El repositorio rechaza una lista vacía. */
  messageIds: string[];
  observation: string;
  confidence: number;
  analyses: DetectedAnalysis[];
  /** Case existente al que se asocia, o los datos para crear uno nuevo. */
  target: { kind: "existing"; caseId: string } | { kind: "new"; title: string; category: CaseCategory };
}

export interface RecordEventDetectionInput {
  conversationId: string;
  /** Mensajes de la ventana procesada — todos avanzan de estado, hayan producido eventos o no. */
  processedMessageIds: string[];
  events: EventToPersist[];
  /** Modelo y versión de prompt que produjeron la interpretación (SI-019/SI-020). */
  model: string;
  promptVersion: string;
}

export interface CaseRepository {
  /**
   * Mensajes en 'ENTITY_READY' (Pipeline 5 corre después del 4,
   * docs/PIPELINES.md "Dependencias"), ordenados cronológicamente —
   * el orden importa porque la ventana de análisis es conversacional.
   * PL-003: reejecutable de forma independiente.
   */
  findMessagesPendingEventDetection(
    conversationId: string,
    limit: number
  ): Promise<MessageForEventDetection[]>;

  /** Cases abiertos de la conversación, con la fecha de su Event más reciente. */
  findOpenCases(conversationId: string): Promise<OpenCaseSummary[]>;

  /**
   * Persiste, en una sola transacción por ventana: los Case nuevos que
   * hagan falta, los Event, sus filas en event_messages (SI-014), la
   * Analysis y la Observation de cada uno, y el avance de
   * message_processing_state a 'CASE_READY' de todos los mensajes de la
   * ventana.
   *
   * Todo junto porque un Event sin su fila en event_messages sería una
   * interpretación sin evidencia (SI-015/SI-024), y un mensaje marcado
   * CASE_READY sin sus eventos persistidos perdería el trabajo sin
   * posibilidad de reintento (el estado no vuelve atrás).
   */
  recordEventDetection(input: RecordEventDetectionInput): Promise<void>;
}
