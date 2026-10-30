// Único repositorio del Aggregate Conversation (docs/AGGREGATES.md,
// AG-002/AG-003): administra Conversation/Participant/Message/Attachment
// como una sola unidad — nunca un MessageRepository ni AttachmentRepository
// sueltos. La interfaz vive acá (dominio); la implementación Postgres está
// en src/archive/infrastructure/conversation-repository.drizzle.ts.

import type {
  AttachmentType,
  MessageKind,
  MessageStatus,
} from "../domain/conversation.js";

export interface NewMessageInput {
  participantId: string;
  sentAt: Date;
  content: string;
  kind: MessageKind;
  deletedBySender: boolean;
  rawSource: string;
  status: MessageStatus;
  contentHash: string;
  attachment: { type: AttachmentType; status: "unavailable" } | null;
}

export interface InsertedMessage {
  id: string;
  contentHash: string;
}

export interface ConversationRepository {
  /** v1 asume una sola Conversation — la busca sin crearla. */
  findConversation(): Promise<{ id: string } | null>;

  /** Crea la Conversation si todavía no existe (v1: una sola). */
  getOrCreateConversation(title: string | null): Promise<{ id: string }>;

  /** Dedup por `display_name` dentro de la Conversation. */
  getOrCreateParticipant(
    conversationId: string,
    displayName: string,
    role: string
  ): Promise<{ id: string }>;

  /** Total de mensajes ya persistidos (para status.json). */
  countMessages(conversationId: string): Promise<number>;

  /**
   * Devuelve el subconjunto de `hashes` que TODAVÍA NO está persistido
   * para esta conversación — dedup por content_hash (PL-004/SI-031).
   */
  filterNewContentHashes(
    conversationId: string,
    hashes: string[]
  ): Promise<Set<string>>;

  /**
   * Inserta mensajes (y su adjunto, si tienen) ya filtrados de
   * duplicados. Cada mensaje se persiste en su propia transacción
   * atómica (mensaje + adjunto), no en una única transacción para todo
   * el lote: así, si falla a mitad de archivo, lo ya insertado
   * sobrevive y una reimportación puede continuar desde ahí
   * (docs/ERROR_HANDLING.md, "Recuperación por lote").
   */
  insertMessages(
    conversationId: string,
    messages: NewMessageInput[]
  ): Promise<InsertedMessage[]>;
}
