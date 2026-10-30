// Repositorio para el estado del Pipeline General y sus artefactos
// deterministas (Pipeline 3 - Metadata Extraction). No es el repositorio
// del Aggregate Conversation (ese es ConversationRepository,
// src/archive/repositories/) — este solo administra tablas de
// conocimiento derivado (message_metadata, message_processing_state),
// nunca escribe en messages/participants/attachments.

import type { ExtractedMetadata } from "../domain/metadata-extraction.js";
import type { DetectedEntity } from "../domain/entity-detection.js";

export interface MessageForMetadataExtraction {
  id: string;
  content: string;
  kind: string;
  participantId: string;
}

export interface ParticipantForMetadataExtraction {
  id: string;
  displayName: string;
}

export interface MessageForEntityDetection {
  id: string;
  content: string;
  kind: string;
}

export interface ProcessingRepository {
  /**
   * Participantes de la Conversation (para resolver menciones) — lectura
   * simple, no reemplaza a ConversationRepository.
   */
  listParticipants(
    conversationId: string
  ): Promise<ParticipantForMetadataExtraction[]>;

  /**
   * Mensajes cuyo message_processing_state es 'PERSISTED' (implícito por
   * ausencia de fila, o explícito) — todavía no pasaron por Metadata
   * Extraction. PL-003: reejecutable de forma independiente.
   */
  findMessagesPendingMetadataExtraction(
    conversationId: string,
    limit: number
  ): Promise<MessageForMetadataExtraction[]>;

  /**
   * Upsert de message_metadata + avance de message_processing_state a
   * METADATA_READY, en una sola transacción por mensaje (mismo patrón de
   * `docs/ERROR_HANDLING.md` "Recuperación por lote" que
   * ConversationRepository.insertMessages: si el lote falla a mitad de
   * camino, lo ya marcado sobrevive).
   */
  recordMetadataExtraction(
    messageId: string,
    metadata: ExtractedMetadata
  ): Promise<void>;

  /**
   * Mensajes en estado 'METADATA_READY' (Pipeline 4 corre después de
   * Pipeline 3, docs/PIPELINES.md "Dependencias") que todavía no
   * llegaron a 'ENTITY_READY'. PL-003: reejecutable de forma
   * independiente.
   */
  findMessagesPendingEntityDetection(
    conversationId: string,
    limit: number
  ): Promise<MessageForEntityDetection[]>;

  /**
   * Reemplaza (delete + reinsert) las entidades de un mensaje —
   * message_entities es 0:N, no 1:1 como message_metadata, así que no
   * hay upsert por fila individual (docs/DATA_MODEL.md, "Entidades
   * extraídas") — y avanza message_processing_state a 'ENTITY_READY',
   * en una sola transacción por mensaje.
   */
  recordEntityDetection(
    messageId: string,
    entities: DetectedEntity[]
  ): Promise<void>;
}
