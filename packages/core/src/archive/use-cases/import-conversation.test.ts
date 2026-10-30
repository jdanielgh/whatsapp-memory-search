// Tests obligatorios de whatsapp-ingest (rules/dev-style.md): dedup e
// idempotencia (PL-004/SI-031) y recuperación por lote
// (docs/ERROR_HANDLING.md). Usa repositorios en memoria (fakes) en vez de
// Postgres real, para que corran rápido y sin estado compartido — las
// interfaces (ConversationRepository/ImportJobRepository) son el punto de
// extensión pensado justamente para esto. Todos los fixtures son texto
// inventado (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ConversationRepository,
  InsertedMessage,
  NewMessageInput,
} from "../repositories/conversation-repository.js";
import type { ImportJobRepository } from "../repositories/import-job-repository.js";
import type { SourceType } from "../domain/import-job.js";
import {
  importConversation,
  type ImportConversationDeps,
} from "./import-conversation.js";
import {
  ConversationNotFoundError,
  syncNewMessages,
} from "./sync-new-messages.js";

const NBSP = " "; // U+202F, espacio angosto de no separación
const DEFAULT_INPUT_OPTS = {
  timeZone: { kind: "fixed", utcOffsetMinutes: 0 } as const,
  dateFormat: "dmy" as const,
};

function line(date: string, time: string, meridiem: "a.m." | "p.m.", rest: string): string {
  return `[${date}, ${time}${NBSP}${meridiem}] ${rest}`;
}

class FakeConversationRepository implements ConversationRepository {
  conversation: { id: string } | null = null;
  participants = new Map<string, { id: string; displayName: string; role: string }>();
  messages: Array<NewMessageInput & { id: string }> = [];
  /** Si se fija, insertMessages lanza justo después de insertar esta cantidad (simula fallo a mitad de lote). */
  failAfterInsertingCount: number | null = null;

  async findConversation() {
    return this.conversation;
  }

  async getOrCreateConversation(title: string | null) {
    if (!this.conversation) {
      this.conversation = { id: randomUUID() };
    }
    return this.conversation;
  }

  async getOrCreateParticipant(conversationId: string, displayName: string, role: string) {
    const key = `${conversationId}::${displayName}`;
    const existing = this.participants.get(key);
    if (existing) return { id: existing.id };
    const created = { id: randomUUID(), displayName, role };
    this.participants.set(key, created);
    return { id: created.id };
  }

  async countMessages(conversationId: string): Promise<number> {
    return this.messages.length;
  }

  async filterNewContentHashes(conversationId: string, hashes: string[]): Promise<Set<string>> {
    const existing = new Set(this.messages.map((m) => m.contentHash));
    return new Set(hashes.filter((h) => !existing.has(h)));
  }

  async insertMessages(
    conversationId: string,
    toInsert: NewMessageInput[]
  ): Promise<InsertedMessage[]> {
    const inserted: InsertedMessage[] = [];
    let countThisCall = 0;
    for (const m of toInsert) {
      if (
        this.failAfterInsertingCount !== null &&
        countThisCall === this.failAfterInsertingCount
      ) {
        throw new Error("Fallo simulado a mitad de lote (persistencia no disponible)");
      }
      const row = { id: randomUUID(), ...m };
      this.messages.push(row); // ya "committed" antes de que una fila posterior falle
      inserted.push({ id: row.id, contentHash: row.contentHash });
      countThisCall += 1;
    }
    return inserted;
  }
}

class FakeImportJobRepository implements ImportJobRepository {
  jobs = new Map<
    string,
    { status: string; messagesImported: number; errorSummary: string | null }
  >();

  async getOrCreateSource(type: SourceType) {
    return { id: `source:${type}` };
  }

  async createImportJob(conversationId: string, sourceId: string) {
    const id = randomUUID();
    this.jobs.set(id, { status: "RUNNING", messagesImported: 0, errorSummary: null });
    return { id };
  }

  async completeImportJob(importJobId: string, messagesImported: number): Promise<void> {
    this.jobs.set(importJobId, { status: "SUCCESS", messagesImported, errorSummary: null });
  }

  async failImportJob(importJobId: string, errorSummary: string): Promise<void> {
    const prev = this.jobs.get(importJobId);
    this.jobs.set(importJobId, {
      status: "FAILED",
      messagesImported: prev?.messagesImported ?? 0,
      errorSummary,
    });
  }
}

function makeDeps(): {
  deps: ImportConversationDeps;
  conversationRepo: FakeConversationRepository;
  importJobRepo: FakeImportJobRepository;
  auditEntries: unknown[];
} {
  const conversationRepo = new FakeConversationRepository();
  const importJobRepo = new FakeImportJobRepository();
  const auditEntries: unknown[] = [];
  const deps: ImportConversationDeps = {
    conversationRepo,
    importJobRepo,
    audit: async (entry) => {
      auditEntries.push(entry);
    },
  };
  return { deps, conversationRepo, importJobRepo, auditEntries };
}

describe("importConversation (UC-001)", () => {
  it("crea la Conversation, los Participants y persiste los mensajes", async () => {
    const { deps, conversationRepo } = makeDeps();
    const raw = [
      line("01/02/24", "10:00:00", "a.m.", "Ana: hola"),
      line("01/02/24", "10:01:00", "a.m.", "Beto: hola de vuelta"),
    ].join("\n");

    const result = await importConversation(deps, { rawExport: raw, ...DEFAULT_INPUT_OPTS });

    expect(result.messagesImported).toBe(2);
    expect(result.messagesSkippedAsDuplicate).toBe(0);
    expect(conversationRepo.messages).toHaveLength(2);
    expect(conversationRepo.participants.size).toBe(2);
  });

  it("reimportar el mismo export no duplica mensajes (dedup por content_hash)", async () => {
    const { deps, conversationRepo } = makeDeps();
    const raw = [
      line("01/02/24", "10:00:00", "a.m.", "Ana: hola"),
      line("01/02/24", "10:01:00", "a.m.", "Beto: hola de vuelta"),
    ].join("\n");

    const first = await importConversation(deps, { rawExport: raw, ...DEFAULT_INPUT_OPTS });
    const second = await importConversation(deps, { rawExport: raw, ...DEFAULT_INPUT_OPTS });

    expect(first.messagesImported).toBe(2);
    expect(second.messagesImported).toBe(0);
    expect(second.messagesSkippedAsDuplicate).toBe(2);
    expect(conversationRepo.messages).toHaveLength(2);
    // La segunda corrida reusa la misma Conversation, no crea una nueva.
    expect(second.conversationId).toBe(first.conversationId);
  });

  it("si falla a mitad de lote, lo ya insertado sobrevive y una reimportación completa el resto", async () => {
    const { deps, conversationRepo, importJobRepo } = makeDeps();
    const raw = [
      line("01/02/24", "10:00:00", "a.m.", "Ana: mensaje 1"),
      line("01/02/24", "10:01:00", "a.m.", "Ana: mensaje 2"),
      line("01/02/24", "10:02:00", "a.m.", "Ana: mensaje 3"),
    ].join("\n");

    conversationRepo.failAfterInsertingCount = 2;

    await expect(
      importConversation(deps, { rawExport: raw, ...DEFAULT_INPUT_OPTS })
    ).rejects.toThrow("Fallo simulado a mitad de lote");

    // Lo ya insertado antes del fallo sobrevive (EH-001: pérdida de
    // evidencia inaceptable) y el ImportJob queda marcado FAILED.
    expect(conversationRepo.messages).toHaveLength(2);
    const failedJob = [...importJobRepo.jobs.values()].find((j) => j.status === "FAILED");
    expect(failedJob).toBeDefined();
    expect(failedJob!.errorSummary).toContain("Fallo simulado a mitad de lote");

    // Reintentar sin el fallo: dedup evita reinsertar los 2 ya
    // persistidos y completa únicamente el tercero.
    conversationRepo.failAfterInsertingCount = null;
    const retry = await importConversation(deps, { rawExport: raw, ...DEFAULT_INPUT_OPTS });

    expect(retry.messagesImported).toBe(1);
    expect(retry.messagesSkippedAsDuplicate).toBe(2);
    expect(conversationRepo.messages).toHaveLength(3);
  });

  it("registra auditoría de éxito y de fallo", async () => {
    const { deps, conversationRepo, auditEntries } = makeDeps();

    await importConversation(deps, {
      rawExport: line("01/02/24", "10:00:00", "a.m.", "Ana: hola"),
      ...DEFAULT_INPUT_OPTS,
    });
    expect(
      auditEntries.some((e) => (e as { result: string }).result === "success")
    ).toBe(true);

    // Mensaje distinto al anterior: no lo descarta el dedup, así que
    // insertMessages sí intenta insertarlo y dispara el fallo simulado.
    conversationRepo.failAfterInsertingCount = 0;
    await expect(
      importConversation(deps, {
        rawExport: line("01/02/24", "11:00:00", "a.m.", "Ana: otro mensaje"),
        ...DEFAULT_INPUT_OPTS,
      })
    ).rejects.toThrow();
    expect(
      auditEntries.some((e) => (e as { result: string }).result === "failure")
    ).toBe(true);
  });
});

describe("syncNewMessages (UC-002)", () => {
  it("falla si todavía no hay ninguna Conversation importada", async () => {
    const { deps } = makeDeps();
    await expect(
      syncNewMessages(deps, {
        rawExport: line("01/02/24", "10:00:00", "a.m.", "Ana: hola"),
        ...DEFAULT_INPUT_OPTS,
      })
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("sincroniza mensajes nuevos sobre la Conversation existente sin duplicar los ya importados", async () => {
    const { deps, conversationRepo } = makeDeps();
    const firstBatch = line("01/02/24", "10:00:00", "a.m.", "Ana: hola");
    const secondBatch = [
      line("01/02/24", "10:00:00", "a.m.", "Ana: hola"), // ya importado
      line("01/02/24", "10:05:00", "a.m.", "Beto: mensaje nuevo"),
    ].join("\n");

    const imported = await importConversation(deps, {
      rawExport: firstBatch,
      ...DEFAULT_INPUT_OPTS,
    });
    const synced = await syncNewMessages(deps, {
      rawExport: secondBatch,
      ...DEFAULT_INPUT_OPTS,
    });

    expect(synced.conversationId).toBe(imported.conversationId);
    expect(synced.messagesImported).toBe(1);
    expect(synced.messagesSkippedAsDuplicate).toBe(1);
    expect(conversationRepo.messages).toHaveLength(2);
  });
});
