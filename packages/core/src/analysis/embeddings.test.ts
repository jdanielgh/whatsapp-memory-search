// Tests obligatorios de Pipeline 10 (rules/dev-style.md regla 4:
// recuperación RAG). Sin llamadas a la API real (rules/ai-cost.md):
// EmbeddingBatchProvider se reemplaza por un fake determinista, mismo
// patrón que FakeAIProvider en detect-entities.test.ts. Fixtures
// inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EmbeddingBatchOptions,
  EmbeddingBatchProvider,
} from "../infrastructure/ai/provider.js";
import { EmbeddingValidationError } from "../infrastructure/ai/provider.js";
import type {
  EmbeddingsRepository,
  MessageForEmbedding,
  RecordEmbeddingInput,
} from "./repositories/embeddings-repository.js";
import {
  generateEmbeddingsForConversation,
  type GenerateEmbeddingsDeps,
} from "./embeddings.js";

const PENDING_STATUSES = new Set(["CASE_READY", "INSIGHT_READY", "SUMMARY_READY"]);

class FakeEmbeddingProvider implements EmbeddingBatchProvider {
  calls: Array<{ texts: string[]; opts: EmbeddingBatchOptions }> = [];
  response: (texts: string[]) => number[][] = (texts) => texts.map(() => [1, 2, 3]);
  failWith: Error | null = null;

  async embedBatch(texts: string[], opts: EmbeddingBatchOptions): Promise<number[][]> {
    this.calls.push({ texts, opts });
    if (this.failWith) throw this.failWith;
    return this.response(texts);
  }
}

class FakeEmbeddingsRepository implements EmbeddingsRepository {
  messages: Array<MessageForEmbedding & { conversationId: string }> = [];
  processingStatus = new Map<string, string>();
  recordedEmbeddings = new Map<string, RecordEmbeddingInput>();

  async findMessagesPendingEmbedding(
    conversationId: string,
    limit: number
  ): Promise<MessageForEmbedding[]> {
    return this.messages
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          PENDING_STATUSES.has(this.processingStatus.get(m.id) ?? "")
      )
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(0, limit)
      .map(({ conversationId: _c, ...rest }) => rest);
  }

  async findPrecedingMessages(input: {
    conversationId: string;
    beforeSentAt: Date;
    beforeId: string;
    count: number;
  }): Promise<MessageForEmbedding[]> {
    if (input.count <= 0) return [];
    return this.messages
      .filter(
        (m) => m.conversationId === input.conversationId && m.sentAt < input.beforeSentAt
      )
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(-input.count)
      .map(({ conversationId: _c, ...rest }) => rest);
  }

  async recordEmbedding(input: RecordEmbeddingInput): Promise<void> {
    this.recordedEmbeddings.set(input.messageId, input);
    this.processingStatus.set(input.messageId, "EMBEDDED");
  }

  async markEmbeddedWithoutVector(messageId: string): Promise<void> {
    this.processingStatus.set(messageId, "EMBEDDED");
  }
}

function makeDeps(): {
  deps: GenerateEmbeddingsDeps;
  repo: FakeEmbeddingsRepository;
  provider: FakeEmbeddingProvider;
  auditEntries: unknown[];
} {
  const repo = new FakeEmbeddingsRepository();
  const provider = new FakeEmbeddingProvider();
  const auditEntries: unknown[] = [];
  const deps: GenerateEmbeddingsDeps = {
    embeddingsRepo: repo,
    embeddingProvider: provider,
    audit: async (entry) => {
      auditEntries.push(entry);
    },
    model: "voyage-3-large",
    dimensions: 3,
  };
  return { deps, repo, provider, auditEntries };
}

let clock = new Date("2025-01-01T00:00:00Z").getTime();
function addPendingMessage(
  repo: FakeEmbeddingsRepository,
  conversationId: string,
  overrides: Partial<MessageForEmbedding> = {},
  status = "CASE_READY"
): string {
  const id = overrides.id ?? randomUUID();
  clock += 60_000;
  repo.messages.push({
    id,
    conversationId,
    content: overrides.content ?? "hola",
    kind: overrides.kind ?? "text",
    participantId: overrides.participantId ?? "participante-1",
    sentAt: overrides.sentAt ?? new Date(clock),
  });
  repo.processingStatus.set(id, status);
  return id;
}

describe("generateEmbeddingsForConversation (Pipeline 10)", () => {
  it("persiste el embedding y avanza a EMBEDDED", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    const messageId = addPendingMessage(repo, conversationId, { content: "dale, nos vemos" });

    const result = await generateEmbeddingsForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    expect(result.messagesFailed).toBe(0);
    expect(repo.processingStatus.get(messageId)).toBe("EMBEDDED");
    expect(repo.recordedEmbeddings.get(messageId)).toEqual({
      messageId,
      model: "voyage-3-large",
      dims: 3,
      vector: [1, 2, 3],
    });
    expect(provider.calls[0]?.opts.inputType).toBe("document");
    expect(provider.calls[0]?.opts.model).toBe("voyage-3-large");
  });

  it("el chunk incluye el contexto de los mensajes previos del mismo hilo", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId, {
      content: "te va bien el sábado?",
      participantId: "luis",
    });
    addPendingMessage(repo, conversationId, { content: "dale", participantId: "ana" });

    await generateEmbeddingsForConversation(deps, { conversationId });

    // El primer mensaje no tiene contexto previo (chunk = solo el ancla);
    // el segundo incluye al primero como contexto.
    expect(provider.calls[0]?.texts).toEqual([
      "Participante 1: te va bien el sábado?",
      "Participante 1: te va bien el sábado?\nParticipante 2: dale",
    ]);
  });

  it("agrupa varios mensajes en una sola llamada a Voyage (palanca de costo)", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 10; i += 1) {
      addPendingMessage(repo, conversationId, { content: `mensaje ${i}` });
    }

    const result = await generateEmbeddingsForConversation(deps, {
      conversationId,
      aiBatchSize: 5,
    });

    expect(result.messagesProcessed).toBe(10);
    expect(result.aiCalls).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("es idempotente: reejecutar no vuelve a llamar a Voyage para mensajes ya EMBEDDED", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);

    await generateEmbeddingsForConversation(deps, { conversationId });
    const callsAfterFirst = provider.calls.length;
    const second = await generateEmbeddingsForConversation(deps, { conversationId });

    expect(second.messagesProcessed).toBe(0);
    expect(provider.calls.length).toBe(callsAfterFirst);
  });

  it("mensajes kind != text no llaman a Voyage y quedan EMBEDDED sin fila en embeddings", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    const messageId = addPendingMessage(repo, conversationId, { kind: "call" });

    const result = await generateEmbeddingsForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    expect(provider.calls).toHaveLength(0);
    expect(repo.processingStatus.get(messageId)).toBe("EMBEDDED");
    expect(repo.recordedEmbeddings.has(messageId)).toBe(false);
  });

  it("una EmbeddingValidationError afecta solo a su grupo, no al resto del lote (SI-034)", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    const brokenId = addPendingMessage(repo, conversationId, { content: "raro" });
    const okId = addPendingMessage(repo, conversationId, { content: "normal" });

    // aiBatchSize=1 => un grupo por mensaje: el primer chunk (brokenId,
    // que es el cronológicamente más antiguo) falla, el segundo no.
    let callCount = 0;
    provider.embedBatch = async (texts, opts) => {
      callCount += 1;
      provider.calls.push({ texts, opts });
      if (callCount === 1) throw new EmbeddingValidationError("forma inesperada");
      return texts.map(() => [1, 2, 3]);
    };

    const result = await generateEmbeddingsForConversation(deps, {
      conversationId,
      aiBatchSize: 1,
    });

    expect(result.messagesProcessed).toBe(1);
    expect(result.messagesFailed).toBe(1);
    expect(repo.processingStatus.get(brokenId)).toBe("CASE_READY");
    expect(repo.processingStatus.get(okId)).toBe("EMBEDDED");
  });

  it("un fallo sistémico del proveedor (ej. sin saldo) aborta la corrida en vez de tratarse como fallo por mensaje", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    const first = addPendingMessage(repo, conversationId);
    addPendingMessage(repo, conversationId);
    provider.failWith = new Error("401 invalid credential");

    await expect(
      generateEmbeddingsForConversation(deps, { conversationId })
    ).rejects.toThrow("invalid credential");

    expect(repo.processingStatus.get(first)).toBe("CASE_READY");
  });

  it("respeta maxMessages y deja el resto pendiente (control de gasto)", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 10; i += 1) addPendingMessage(repo, conversationId);

    const result = await generateEmbeddingsForConversation(deps, {
      conversationId,
      maxMessages: 3,
      aiBatchSize: 2,
    });

    expect(result.messagesProcessed).toBe(3);
    const pendientes = [...repo.processingStatus.values()].filter((s) => s === "CASE_READY");
    expect(pendientes).toHaveLength(7);
  });

  it("reporta los tokens consumidos para poder registrar el costo real", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);
    const seen: unknown[] = [];
    deps.onUsage = (u) => seen.push(u);

    await generateEmbeddingsForConversation(deps, { conversationId });

    const provider = deps.embeddingProvider as unknown as FakeEmbeddingProvider;
    expect(provider.calls[0]?.opts.onUsage).toBe(deps.onUsage);
  });

  it("rechaza un aiBatchSize no positivo en vez de colgarse", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);

    await expect(
      generateEmbeddingsForConversation(deps, { conversationId, aiBatchSize: 0 })
    ).rejects.toThrow(/aiBatchSize/);
    expect(provider.calls).toHaveLength(0);
  });

  it("no reintenta chunks ya fallidos dentro de la misma corrida cuando fallos >= batchSize (evita loop infinito y gasto no acotado)", async () => {
    const { deps, repo, provider } = makeDeps();
    const conversationId = randomUUID();
    const brokenA = addPendingMessage(repo, conversationId, { content: "roto A" });
    const brokenB = addPendingMessage(repo, conversationId, { content: "roto B" });
    provider.embedBatch = async (texts, opts) => {
      provider.calls.push({ texts, opts });
      throw new EmbeddingValidationError("forma inesperada");
    };

    const result = await Promise.race([
      generateEmbeddingsForConversation(deps, {
        conversationId,
        batchSize: 2,
        aiBatchSize: 1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT: probable loop infinito")), 2000)
      ),
    ]);

    expect(result.messagesProcessed).toBe(0);
    expect(result.messagesFailed).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(repo.processingStatus.get(brokenA)).toBe("CASE_READY");
    expect(repo.processingStatus.get(brokenB)).toBe("CASE_READY");
  });
});
