// Repositorio para Embedding Generation (Pipeline 10). No es el
// repositorio del Aggregate Conversation (ese es ConversationRepository,
// src/archive/repositories/) — este solo administra `embeddings`
// (artefacto derivado, sin Aggregate Root propio — docs/AGGREGATES.md) y
// el avance de `message_processing_state` a 'EMBEDDED'. Nunca escribe en
// messages/participants/attachments.

export interface MessageForEmbedding {
  id: string;
  content: string;
  kind: string;
  participantId: string;
  sentAt: Date;
}

export interface RecordEmbeddingInput {
  messageId: string;
  model: string;
  dims: number;
  vector: number[];
}

export interface EmbeddingsRepository {
  /**
   * Mensajes listos para generar embedding, en orden cronológico (el
   * orden importa: el chunk de un mensaje depende de los que lo
   * preceden). "Listo" es `status IN ('CASE_READY', 'INSIGHT_READY',
   * 'SUMMARY_READY')` — no se exige igualdad estricta con 'SUMMARY_READY'
   * como marca `docs/PIPELINES.md` porque las fases 07 (Insights/
   * Summaries) todavía no existen en código; `plans/`
   * declara que esta fase solo depende de `03-processing-knowledge.md`.
   * Ver docs/DECISIONS.md, "Embeddings: proveedor, modelo, chunking,
   * top-k y regeneración" — cuando la fase 07 exista, mensajes que
   * avancen a INSIGHT_READY/SUMMARY_READY se siguen recogiendo sin
   * cambios acá.
   */
  findMessagesPendingEmbedding(
    conversationId: string,
    limit: number
  ): Promise<MessageForEmbedding[]>;

  /**
   * Los hasta `count` mensajes inmediatamente anteriores a
   * (`beforeSentAt`, `beforeId`) en la misma conversación, en orden
   * cronológico ASCENDENTE. Evidencia ya persistida (SI-002): nunca
   * cambia, así que el chunk de un mensaje es determinista para siempre.
   * No filtra por `message_processing_state` — el contexto no necesita
   * estar embebido él mismo, solo existir.
   */
  findPrecedingMessages(input: {
    conversationId: string;
    beforeSentAt: Date;
    beforeId: string;
    count: number;
  }): Promise<MessageForEmbedding[]>;

  /**
   * Inserta la fila de `embeddings` (nunca `UPDATE` — SI-028) y avanza
   * `message_processing_state` a 'EMBEDDED', en una sola transacción por
   * mensaje (mismo patrón de recuperación por lote que
   * `ProcessingRepository.recordEntityDetection`).
   */
  recordEmbedding(input: RecordEmbeddingInput): Promise<void>;

  /**
   * Avanza a 'EMBEDDED' sin insertar fila en `embeddings` — mensajes
   * `kind != 'text'` (llamada/sistema) no tienen contenido semántico que
   * buscar, mismo criterio que Entity Detection con lista vacía.
   */
  markEmbeddedWithoutVector(messageId: string): Promise<void>;
}
