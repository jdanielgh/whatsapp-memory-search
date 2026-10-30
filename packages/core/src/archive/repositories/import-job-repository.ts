// Repositorio del Aggregate ImportJob (docs/AGGREGATES.md: Aggregate Root
// propio, separado de Conversation). import_jobs no es evidencia
// (SI-002/003/043 solo cubre conversations/participants/messages/
// attachments) — sí puede actualizarse para reflejar su propio estado.

import type { SourceType } from "../domain/import-job.js";

export interface ImportJobRepository {
  getOrCreateSource(type: SourceType): Promise<{ id: string }>;

  createImportJob(
    conversationId: string,
    sourceId: string
  ): Promise<{ id: string }>;

  completeImportJob(
    importJobId: string,
    messagesImported: number
  ): Promise<void>;

  failImportJob(importJobId: string, errorSummary: string): Promise<void>;
}
