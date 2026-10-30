// CLI para correr Metadata Extraction (Pipeline 3) sobre la Conversation
// existente. Uso: `npm run process:metadata`. Reejecutable en cualquier
// momento (PL-003) — solo procesa mensajes que todavía no llegaron a
// METADATA_READY. Nunca imprime contenido de mensajes, solo el resumen
// numérico (rules/security-privacy.md).

import { recordAudit } from "../../shared/audit.js";
import { DrizzleConversationRepository } from "../../archive/infrastructure/conversation-repository.drizzle.js";
import { extractMetadataForConversation } from "../use-cases/extract-metadata.js";
import { DrizzleProcessingRepository } from "./processing-repository.drizzle.js";
import { errorSummary } from "../../shared/error-summary.js";

async function main(): Promise<void> {
  const conversationRepo = new DrizzleConversationRepository();
  const conversation = await conversationRepo.findConversation();
  if (!conversation) {
    throw new Error(
      "No hay ninguna Conversation importada todavía — corré `npm run sync` primero."
    );
  }

  const result = await extractMetadataForConversation(
    { processingRepo: new DrizzleProcessingRepository(), audit: recordAudit },
    { conversationId: conversation.id }
  );

  console.log(
    JSON.stringify(
      { conversationId: conversation.id, messagesProcessed: result.messagesProcessed },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(errorSummary(err));
  process.exitCode = 1;
});
