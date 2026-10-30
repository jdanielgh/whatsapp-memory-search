// Pipeline 3 - Metadata Extraction (docs/PIPELINES.md). Orquesta:
// buscar mensajes pendientes (message_processing_state = 'PERSISTED'
// implícito o explícito), calcular metadata determinista
// (metadata-extraction.ts) y persistirla + avanzar el estado. Reejecutar
// esta función es seguro (PL-003/PL-004): solo toca mensajes que
// todavía no llegaron a METADATA_READY.

import type { AuditRecorder } from "../../shared/audit.js";
import { extractMetadata } from "../domain/metadata-extraction.js";
import type { ProcessingRepository } from "../repositories/processing-repository.js";

export interface ExtractMetadataDeps {
  processingRepo: ProcessingRepository;
  audit: AuditRecorder;
}

export interface ExtractMetadataInput {
  conversationId: string;
  /** Tamaño de lote por corrida — evita cargar toda la conversación en memoria. */
  batchSize?: number;
}

export interface ExtractMetadataResult {
  messagesProcessed: number;
}

const DEFAULT_BATCH_SIZE = 500;

/** UC interno de Pipeline 3 — no tiene UC-xxx propio en docs/USE_CASES.md
 * (Metadata Extraction es infraestructura del Pipeline General, no un
 * caso de uso visible al usuario). */
export async function extractMetadataForConversation(
  deps: ExtractMetadataDeps,
  input: ExtractMetadataInput
): Promise<ExtractMetadataResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const participants = await deps.processingRepo.listParticipants(
    input.conversationId
  );

  let messagesProcessed = 0;
  for (;;) {
    const pending = await deps.processingRepo.findMessagesPendingMetadataExtraction(
      input.conversationId,
      batchSize
    );
    if (pending.length === 0) break;

    for (const message of pending) {
      // Se excluye al propio remitente: "mención" tiene sentido para
      // referirse a otra persona en la conversación, no a uno mismo.
      const otherParticipants = participants.filter(
        (p) => p.id !== message.participantId
      );
      const metadata = extractMetadata(message, otherParticipants);
      await deps.processingRepo.recordMetadataExtraction(message.id, metadata);
      messagesProcessed += 1;
    }

    // Lote más chico que el batchSize: no hay más pendientes.
    if (pending.length < batchSize) break;
  }

  await deps.audit({
    actor: "ExtractMetadataForConversation",
    operation: "metadata_extraction",
    resourceType: "Conversation",
    resourceId: input.conversationId,
    result: "success",
    details: { messagesProcessed },
  });

  return { messagesProcessed };
}
