// Tests obligatorios de Pipeline 3 (rules/dev-style.md: fallo silencioso
// acá dejaría mensajes marcados METADATA_READY sin metadata real, o
// reprocesando indefinidamente). Repositorio en memoria (fake), fixtures
// inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtractedMetadata } from "../domain/metadata-extraction.js";
import type {
  MessageForMetadataExtraction,
  ParticipantForMetadataExtraction,
  ProcessingRepository,
} from "../repositories/processing-repository.js";
import {
  extractMetadataForConversation,
  type ExtractMetadataDeps,
} from "./extract-metadata.js";

class FakeProcessingRepository implements ProcessingRepository {
  participantsByConversation = new Map<
    string,
    ParticipantForMetadataExtraction[]
  >();
  messages: Array<MessageForMetadataExtraction & { conversationId: string }> =
    [];
  processingStatus = new Map<string, string>(); // messageId -> status
  recordedMetadata = new Map<string, ExtractedMetadata>();

  async listParticipants(conversationId: string) {
    return this.participantsByConversation.get(conversationId) ?? [];
  }

  // No usados por estos tests (Pipeline 3) — stubs para satisfacer la
  // interfaz, que también cubre Pipeline 4 (ver processing-repository.ts).
  async findMessagesPendingEntityDetection() {
    return [];
  }
  async recordEntityDetection(): Promise<void> {}

  async findMessagesPendingMetadataExtraction(
    conversationId: string,
    limit: number
  ) {
    return this.messages
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          (this.processingStatus.get(m.id) ?? "PERSISTED") === "PERSISTED"
      )
      .slice(0, limit)
      .map(({ conversationId: _c, ...rest }) => rest);
  }

  async recordMetadataExtraction(
    messageId: string,
    metadata: ExtractedMetadata
  ) {
    this.recordedMetadata.set(messageId, metadata);
    this.processingStatus.set(messageId, "METADATA_READY");
  }
}

function makeDeps(): {
  deps: ExtractMetadataDeps;
  repo: FakeProcessingRepository;
  auditEntries: unknown[];
} {
  const repo = new FakeProcessingRepository();
  const auditEntries: unknown[] = [];
  const deps: ExtractMetadataDeps = {
    processingRepo: repo,
    audit: async (entry) => {
      auditEntries.push(entry);
    },
  };
  return { deps, repo, auditEntries };
}

describe("extractMetadataForConversation (Pipeline 3)", () => {
  it("procesa mensajes pendientes y avanza su estado a METADATA_READY", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    const juan = { id: randomUUID(), displayName: "Juan" };
    repo.participantsByConversation.set(conversationId, [juan]);
    const msg1 = {
      id: randomUUID(),
      conversationId,
      content: "Hola, vale, nos vemos hoy 😀",
      kind: "text",
      participantId: juan.id,
    };
    repo.messages.push(msg1);

    const result = await extractMetadataForConversation(deps, {
      conversationId,
    });

    expect(result.messagesProcessed).toBe(1);
    expect(repo.processingStatus.get(msg1.id)).toBe("METADATA_READY");
    expect(repo.recordedMetadata.get(msg1.id)?.language).toBe("es");
    expect(repo.recordedMetadata.get(msg1.id)?.emojiCount).toBe(1);
  });

  it("es idempotente: reejecutar no vuelve a procesar mensajes ya METADATA_READY", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    const juan = { id: randomUUID(), displayName: "Juan" };
    repo.participantsByConversation.set(conversationId, [juan]);
    repo.messages.push({
      id: randomUUID(),
      conversationId,
      content: "Hola vale",
      kind: "text",
      participantId: juan.id,
    });

    const first = await extractMetadataForConversation(deps, { conversationId });
    const second = await extractMetadataForConversation(deps, { conversationId });

    expect(first.messagesProcessed).toBe(1);
    expect(second.messagesProcessed).toBe(0);
  });

  it("no bloquea la persistencia de mensajes nuevos si uno individual falla (SI-034): propaga el error sin perder lo ya marcado", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    const juan = { id: randomUUID(), displayName: "Juan" };
    repo.participantsByConversation.set(conversationId, [juan]);
    const ok = {
      id: randomUUID(),
      conversationId,
      content: "Mensaje ok",
      kind: "text",
      participantId: juan.id,
    };
    const broken = {
      id: randomUUID(),
      conversationId,
      content: "Mensaje que falla",
      kind: "text",
      participantId: juan.id,
    };
    repo.messages.push(ok, broken);

    const originalRecord = repo.recordMetadataExtraction.bind(repo);
    repo.recordMetadataExtraction = async (messageId, metadata) => {
      if (messageId === broken.id) {
        throw new Error("Fallo simulado de persistencia");
      }
      return originalRecord(messageId, metadata);
    };

    await expect(
      extractMetadataForConversation(deps, { conversationId })
    ).rejects.toThrow("Fallo simulado de persistencia");

    // El mensaje procesado antes del fallo queda marcado; no se pierde
    // ni se revierte por el fallo del siguiente.
    expect(repo.processingStatus.get(ok.id)).toBe("METADATA_READY");
    expect(repo.processingStatus.get(broken.id)).toBeUndefined();
  });

  it("mensajes kind != text quedan METADATA_READY con metadata vacía (no se reprocesan indefinidamente)", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    const sistema = { id: randomUUID(), displayName: "Sistema" };
    const callMessageId = randomUUID();
    repo.participantsByConversation.set(conversationId, [sistema]);
    repo.messages.push({
      id: callMessageId,
      conversationId,
      content: "Llamada perdida",
      kind: "call",
      participantId: sistema.id,
    });

    const result = await extractMetadataForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    const metadata = repo.recordedMetadata.get(callMessageId);
    expect(metadata?.language).toBeNull();
    expect(metadata?.emojiCount).toBe(0);
  });
});
