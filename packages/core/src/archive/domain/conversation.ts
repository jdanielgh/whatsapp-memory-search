// Tipos de dominio del Aggregate Conversation (docs/DOMAIN_MODEL.md,
// docs/AGGREGATES.md). Sin dependencias externas — ver src/archive/README.md.

export type MessageKind = "text" | "call" | "system";
export type AttachmentType =
  | "imagen"
  | "audio"
  | "video"
  | "documento"
  | "sticker";
export type AttachmentStatus = "available" | "unavailable";

// docs/PIPELINES.md, "Estados del procesamiento". Esta fase (Pipeline 1)
// solo deja mensajes en 'PERSISTED' — el resto lo asignan fases futuras.
export type MessageStatus =
  | "NEW"
  | "IMPORTED"
  | "PERSISTED"
  | "METADATA_READY"
  | "ENTITY_READY"
  | "EVENT_READY"
  | "CASE_READY"
  | "INSIGHT_READY"
  | "SUMMARY_READY"
  | "EMBEDDED"
  | "INDEXED"
  | "READY";

export interface Conversation {
  id: string;
  title: string | null;
}

export interface Participant {
  id: string;
  conversationId: string;
  displayName: string;
  role: string;
}

export interface Attachment {
  id: string;
  messageId: string;
  type: AttachmentType;
  status: AttachmentStatus;
  storagePath: string | null;
  fileHash: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  participantId: string;
  sentAt: Date;
  content: string;
  kind: MessageKind;
  deletedBySender: boolean;
  rawSource: string;
  status: MessageStatus;
  contentHash: string;
}

// Participante sintético para mensajes sin remitente real (avisos de
// sistema del export, ver whatsapp-parser.ts / docs/DATA_MODEL.md,
// "Clasificación de líneas"). Constante única para que ImportConversation
// y SyncNewMessages no inventen cada uno su propio nombre/rol — evita
// crear dos Participants "Sistema" distintos entre corridas.
export const SYSTEM_PARTICIPANT_DISPLAY_NAME = "Sistema";
export const SYSTEM_PARTICIPANT_ROLE = "sistema";

// Rol por defecto de un remitente real cuando quien importa no indicó
// explícitamente el mapping (organizador/miembro/etc.) — nunca se infiere a
// partir del nombre (rules/security-privacy.md: no inventar información
// sobre las personas reales de la conversación).
export const UNKNOWN_PARTICIPANT_ROLE = "desconocido";
