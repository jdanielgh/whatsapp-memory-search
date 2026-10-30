// UC-002 (docs/USE_CASES.md) / Pipeline 2 - Sincronización
// (docs/PIPELINES.md): sincroniza un export ya existente contra una
// Conversation que ya debe existir (a diferencia de ImportConversation,
// que la crea si falta). Reusa persistImportBatch para no duplicar el
// camino de dedup/auditoría/cierre de ImportJob.

import type {
  ImportConversationDeps,
  ImportOutcome,
  ParsedExportInput,
} from "./import-conversation.js";
import { persistImportBatch } from "./import-conversation.js";

export class ConversationNotFoundError extends Error {
  constructor() {
    super(
      "No hay ninguna Conversation existente para sincronizar — importá primero con ImportConversation (UC-001)."
    );
    this.name = "ConversationNotFoundError";
  }
}

export type SyncNewMessagesInput = ParsedExportInput;

export interface SyncNewMessagesResult extends ImportOutcome {
  conversationId: string;
  importJobId: string;
}

/** UC-002: sincroniza mensajes nuevos sobre una Conversation existente. */
export async function syncNewMessages(
  deps: ImportConversationDeps,
  input: SyncNewMessagesInput
): Promise<SyncNewMessagesResult> {
  const conversation = await deps.conversationRepo.findConversation();
  if (!conversation) {
    throw new ConversationNotFoundError();
  }

  const source = await deps.importJobRepo.getOrCreateSource("whatsapp_export");
  const importJob = await deps.importJobRepo.createImportJob(
    conversation.id,
    source.id
  );
  await deps.audit({
    actor: "SyncNewMessages",
    operation: "import_started",
    resourceType: "ImportJob",
    resourceId: importJob.id,
    result: "success",
  });

  const outcome = await persistImportBatch(
    deps,
    conversation.id,
    importJob.id,
    input,
    "SyncNewMessages"
  );

  return { conversationId: conversation.id, importJobId: importJob.id, ...outcome };
}
