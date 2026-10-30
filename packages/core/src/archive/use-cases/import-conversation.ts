// UC-001 (docs/USE_CASES.md) / Pipeline 1 - Importación (docs/PIPELINES.md).
// Orquesta: parsear el export (whatsapp-parser.ts), crear/reusar la
// Conversation, resolver Participants, dedup por content_hash, persistir
// Messages/Attachments, y cerrar el ImportJob. Deja los mensajes en
// status 'PERSISTED' — el resto del Pipeline General es de fases
// posteriores (plans/, "Explícitamente fuera de
// esta fase").

import type { AuditRecorder } from "../../shared/audit.js";
import type { StatusUpdater } from "../../infrastructure/status-writer.js";
import {
  SYSTEM_PARTICIPANT_DISPLAY_NAME,
  SYSTEM_PARTICIPANT_ROLE,
  UNKNOWN_PARTICIPANT_ROLE,
} from "../domain/conversation.js";
import { computeContentHash } from "../domain/content-hash.js";
import {
  parseWhatsAppExport,
  type ParseWarning,
  type TimeZoneStrategy,
} from "../infrastructure/whatsapp-parser.js";
import type {
  ConversationRepository,
  NewMessageInput,
} from "../repositories/conversation-repository.js";
import type { ImportJobRepository } from "../repositories/import-job-repository.js";
import { errorSummary } from "../../shared/error-summary.js";

export interface ImportConversationDeps {
  conversationRepo: ConversationRepository;
  importJobRepo: ImportJobRepository;
  audit: AuditRecorder;
  /** Opcional: si se omite, no se actualiza status.json (útil en tests). */
  updateStatus?: StatusUpdater;
}

export interface ParsedExportInput {
  rawExport: string;
  timeZone: TimeZoneStrategy;
  dateFormat: "dmy" | "mdy";
  /**
   * Mapea el nombre mostrado en el export a un rol
   * (docs/DATA_MODEL.md: etiqueta libre, ej. "organizador" | "miembro" | "sistema"). Sin mapping, el
   * rol de un remitente real queda UNKNOWN_PARTICIPANT_ROLE — nunca se
   * infiere a partir del nombre.
   */
  participantRoles?: Record<string, string>;
}

export interface ImportConversationInput extends ParsedExportInput {
  conversationTitle?: string | null;
}

export interface ImportOutcome {
  messagesImported: number;
  messagesSkippedAsDuplicate: number;
  parseWarnings: ParseWarning[];
}

export interface ImportConversationResult extends ImportOutcome {
  conversationId: string;
  importJobId: string;
}

async function persistParsedMessages(
  conversationRepo: ConversationRepository,
  conversationId: string,
  input: ParsedExportInput
): Promise<ImportOutcome> {
  const { messages: parsedMessages, warnings } = parseWhatsAppExport(
    input.rawExport,
    { timeZone: input.timeZone, dateFormat: input.dateFormat }
  );

  // Clave = displayName real del parser (null solo en mensajes de
  // sistema, ver ParsedMessage.displayName) — nunca el string
  // SYSTEM_PARTICIPANT_DISPLAY_NAME, para no confundir un remitente real
  // que se llame literalmente "Sistema" con el participante sintético.
  const participantIdByName = new Map<string | null, string>();
  const distinctSenders = new Map<string | null, boolean>(
    parsedMessages.map((m) => [m.displayName, m.kind === "system"])
  );
  await Promise.all(
    [...distinctSenders].map(async ([displayNameOrNull, isSystem]) => {
      const displayName = displayNameOrNull ?? SYSTEM_PARTICIPANT_DISPLAY_NAME;
      const role = isSystem
        ? SYSTEM_PARTICIPANT_ROLE
        : input.participantRoles?.[displayName] ?? UNKNOWN_PARTICIPANT_ROLE;
      const participant = await conversationRepo.getOrCreateParticipant(
        conversationId,
        displayName,
        role
      );
      participantIdByName.set(displayNameOrNull, participant.id);
    })
  );

  const candidates = parsedMessages.map((parsed) => {
    const participantId = participantIdByName.get(parsed.displayName)!;
    return {
      parsed,
      participantId,
      contentHash: computeContentHash(
        parsed.sentAt,
        participantId,
        parsed.content
      ),
    };
  });

  const newHashes = await conversationRepo.filterNewContentHashes(
    conversationId,
    candidates.map((c) => c.contentHash)
  );

  const toInsert: NewMessageInput[] = candidates
    .filter((c) => newHashes.has(c.contentHash))
    .map((c) => ({
      participantId: c.participantId,
      sentAt: c.parsed.sentAt,
      content: c.parsed.content,
      kind: c.parsed.kind,
      deletedBySender: c.parsed.deletedBySender,
      rawSource: c.parsed.rawSource,
      status: "PERSISTED",
      contentHash: c.contentHash,
      attachment: c.parsed.attachment,
    }));

  const inserted = await conversationRepo.insertMessages(
    conversationId,
    toInsert
  );

  return {
    messagesImported: inserted.length,
    messagesSkippedAsDuplicate: candidates.length - toInsert.length,
    parseWarnings: warnings,
  };
}

/**
 * Corre la importación sobre una Conversation/ImportJob ya creados y
 * cierra el ImportJob (éxito o fallo) con auditoría — compartido por
 * ImportConversation (UC-001) y SyncNewMessages (UC-002).
 */
export async function persistImportBatch(
  deps: ImportConversationDeps,
  conversationId: string,
  importJobId: string,
  input: ParsedExportInput,
  actor: "ImportConversation" | "SyncNewMessages"
): Promise<ImportOutcome> {
  try {
    const outcome = await persistParsedMessages(
      deps.conversationRepo,
      conversationId,
      input
    );
    await deps.importJobRepo.completeImportJob(
      importJobId,
      outcome.messagesImported
    );
    await deps.audit({
      actor,
      operation: "import",
      resourceType: "ImportJob",
      resourceId: importJobId,
      result: "success",
      details: {
        messagesImported: outcome.messagesImported,
        messagesSkippedAsDuplicate: outcome.messagesSkippedAsDuplicate,
        parseWarningsCount: outcome.parseWarnings.length,
        parseWarnings: outcome.parseWarnings,
      },
    });
    if (deps.updateStatus) {
      const messageCount = await deps.conversationRepo.countMessages(
        conversationId
      );
      await deps.updateStatus({
        last_import_at: new Date().toISOString(),
        message_count: messageCount,
      });
    }
    return outcome;
  } catch (err) {
    const summary = errorSummary(err);
    await deps.importJobRepo.failImportJob(importJobId, summary);
    await deps.audit({
      actor,
      operation: "import",
      resourceType: "ImportJob",
      resourceId: importJobId,
      result: "failure",
      details: { errorSummary: summary },
    });
    throw err;
  }
}

/** UC-001: importa un export completo, creando la Conversation si no existe. */
export async function importConversation(
  deps: ImportConversationDeps,
  input: ImportConversationInput
): Promise<ImportConversationResult> {
  const conversation = await deps.conversationRepo.getOrCreateConversation(
    input.conversationTitle ?? null
  );
  const source = await deps.importJobRepo.getOrCreateSource("whatsapp_export");
  const importJob = await deps.importJobRepo.createImportJob(
    conversation.id,
    source.id
  );
  await deps.audit({
    actor: "ImportConversation",
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
    "ImportConversation"
  );

  return { conversationId: conversation.id, importJobId: importJob.id, ...outcome };
}
