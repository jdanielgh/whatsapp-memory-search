// Tipos de dominio del Aggregate ImportJob (docs/AGGREGATES.md: Aggregate
// Root propio, distinto de Conversation — por eso tiene su propio
// repositorio, ImportJobRepository, en vez de colgar de
// ConversationRepository).

// docs/DATA_MODEL.md / docs/ERROR_HANDLING.md, "Estados de Error".
export type ImportJobStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "RETRYING"
  | "MANUAL_REVIEW";

export type SourceType = "whatsapp_export" | "whatsapp_live";

export interface Source {
  id: string;
  type: SourceType;
}

export interface ImportJob {
  id: string;
  conversationId: string;
  sourceId: string;
  status: ImportJobStatus;
  startedAt: Date;
  finishedAt: Date | null;
  messagesImported: number;
  errorSummary: string | null;
}
