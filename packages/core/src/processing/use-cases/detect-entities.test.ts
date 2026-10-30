// Tests obligatorios de Pipeline 4 (rules/dev-style.md). Sin llamadas a
// la API real (rules/ai-cost.md): AIProvider se reemplaza por un fake
// determinista, mismo patrón que FakeConversationRepository. Fixtures
// inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AIProvider,
  CompletionOptions,
  EmbeddingOptions,
} from "../../infrastructure/ai/provider.js";
import type {
  MessageForEntityDetection,
  ProcessingRepository,
} from "../repositories/processing-repository.js";
import { GENERIC_PROFILE } from "../../shared/generic-profile.js";
import type { ExtractedMetadata } from "../domain/metadata-extraction.js";
import type { DetectedEntity } from "../domain/entity-detection.js";
import {
  detectEntitiesForConversation,
  type DetectEntitiesDeps,
} from "./detect-entities.js";

/** Índices que el prompt le pidió analizar al modelo, en orden. */
function indicesIn(prompt: string): number[] {
  return [...prompt.matchAll(/<mensaje indice="(\d+)">/g)].map((m) => Number(m[1]));
}

/** Respuesta bien formada que contesta por todos los mensajes del lote, sin entidades. */
function emptyAnswerFor(prompt: string): string {
  return JSON.stringify({
    messages: indicesIn(prompt).map((index) => ({ message_index: index, entities: [] })),
  });
}

class FakeAIProvider implements AIProvider {
  calls: Array<{ prompt: string; opts?: CompletionOptions }> = [];
  /** Respuesta a devolver (string JSON) o función para simularla por llamada. */
  response: string | ((prompt: string) => string) = emptyAnswerFor;
  /** Si se fija, complete() lanza este error (simula fallo sistémico: sin saldo, red, etc.). */
  failWith: Error | null = null;

  async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    if (this.failWith) throw this.failWith;
    return typeof this.response === "function" ? this.response(prompt) : this.response;
  }

  async embed(_text: string, _opts?: EmbeddingOptions): Promise<number[]> {
    throw new Error("no usado en estos tests");
  }
}

class FakeProcessingRepository implements ProcessingRepository {
  participantsByConversation = new Map<string, { id: string; displayName: string }[]>();
  messages: Array<MessageForEntityDetection & { conversationId: string }> = [];
  processingStatus = new Map<string, string>();
  recordedEntities = new Map<string, DetectedEntity[]>();

  async listParticipants(conversationId: string) {
    return this.participantsByConversation.get(conversationId) ?? [];
  }
  async findMessagesPendingMetadataExtraction() {
    return [];
  }
  async recordMetadataExtraction(_messageId: string, _metadata: ExtractedMetadata) {}

  async findMessagesPendingEntityDetection(conversationId: string, limit: number) {
    return this.messages
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          this.processingStatus.get(m.id) === "METADATA_READY"
      )
      .slice(0, limit)
      .map(({ conversationId: _c, ...rest }) => rest);
  }

  async recordEntityDetection(messageId: string, entities: DetectedEntity[]) {
    this.recordedEntities.set(messageId, entities);
    this.processingStatus.set(messageId, "ENTITY_READY");
  }
}

function makeDeps(): {
  deps: DetectEntitiesDeps;
  repo: FakeProcessingRepository;
  ai: FakeAIProvider;
  auditEntries: unknown[];
} {
  const repo = new FakeProcessingRepository();
  const ai = new FakeAIProvider();
  const auditEntries: unknown[] = [];
  const deps: DetectEntitiesDeps = {
    processingRepo: repo,
    aiProvider: ai,
    profile: GENERIC_PROFILE,
    audit: async (entry) => {
      auditEntries.push(entry);
    },
  };
  return { deps, repo, ai, auditEntries };
}

function addPendingMessage(
  repo: FakeProcessingRepository,
  conversationId: string,
  overrides: Partial<MessageForEntityDetection> = {}
): string {
  const id = randomUUID();
  repo.messages.push({
    id,
    conversationId,
    content: overrides.content ?? "hola",
    kind: overrides.kind ?? "text",
  });
  repo.processingStatus.set(id, "METADATA_READY");
  return id;
}

describe("detectEntitiesForConversation (Pipeline 4)", () => {
  it("persiste las entidades detectadas y avanza a ENTITY_READY", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const messageId = addPendingMessage(repo, conversationId, {
      content: "nos vemos en el teatro a las 5",
    });
    ai.response = JSON.stringify({
      messages: [
        {
          message_index: 1,
          entities: [{ entity_type: "lugar", value: "el teatro", normalized_value: null }],
        },
      ],
    });

    const result = await detectEntitiesForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    expect(result.messagesFailed).toBe(0);
    expect(repo.processingStatus.get(messageId)).toBe("ENTITY_READY");
    expect(repo.recordedEntities.get(messageId)).toEqual([
      { entityType: "lugar", value: "el teatro", normalizedValue: null },
    ]);
    expect(ai.calls[0]?.opts?.tier).toBe("cheap");
    expect(ai.calls[0]?.opts?.jsonSchema).toBeDefined();
  });

  it("analiza varios mensajes en una sola llamada (es la palanca de costo)", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 10; i += 1) {
      addPendingMessage(repo, conversationId, { content: `mensaje ${i}` });
    }

    const result = await detectEntitiesForConversation(deps, {
      conversationId,
      aiBatchSize: 5,
    });

    expect(result.messagesProcessed).toBe(10);
    // 10 mensajes en grupos de 5 => 2 llamadas, no 10.
    expect(result.aiCalls).toBe(2);
    expect(ai.calls).toHaveLength(2);
  });

  it("atribuye cada entidad al mensaje correcto dentro del lote", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const primero = addPendingMessage(repo, conversationId, { content: "voy al teatro" });
    const segundo = addPendingMessage(repo, conversationId, { content: "paga Ana" });

    ai.response = JSON.stringify({
      messages: [
        { message_index: 2, entities: [{ entity_type: "persona", value: "Ana" }] },
        { message_index: 1, entities: [{ entity_type: "lugar", value: "teatro" }] },
      ],
    });

    await detectEntitiesForConversation(deps, { conversationId, aiBatchSize: 10 });

    // Atribución por message_index, no por orden de llegada: si esto se
    // rompiera, se le colgarían a un mensaje entidades de otro.
    expect(repo.recordedEntities.get(primero)).toEqual([
      { entityType: "lugar", value: "teatro", normalizedValue: null },
    ]);
    expect(repo.recordedEntities.get(segundo)).toEqual([
      { entityType: "persona", value: "Ana", normalizedValue: null },
    ]);
  });

  it("un mensaje omitido por el modelo queda pendiente, no se marca como 'sin entidades'", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const contestado = addPendingMessage(repo, conversationId, { content: "uno" });
    const omitido = addPendingMessage(repo, conversationId, { content: "dos" });

    // El modelo solo contesta por el índice 1.
    ai.response = JSON.stringify({ messages: [{ message_index: 1, entities: [] }] });

    const result = await detectEntitiesForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    expect(result.messagesFailed).toBe(1);
    expect(repo.processingStatus.get(contestado)).toBe("ENTITY_READY");
    // Marcarlo ENTITY_READY con lista vacía lo dejaría para siempre como
    // "analizado, sin entidades" sin que nadie lo note (el estado no
    // vuelve atrás).
    expect(repo.processingStatus.get(omitido)).toBe("METADATA_READY");
    expect(repo.recordedEntities.has(omitido)).toBe(false);
  });

  it("es idempotente: reejecutar no vuelve a llamar a la IA para mensajes ya ENTITY_READY", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);

    await detectEntitiesForConversation(deps, { conversationId });
    const callsAfterFirst = ai.calls.length;
    const second = await detectEntitiesForConversation(deps, { conversationId });

    expect(second.messagesProcessed).toBe(0);
    expect(ai.calls.length).toBe(callsAfterFirst);
  });

  it("mensajes kind != text no llaman a la IA (ahorra costo) y quedan ENTITY_READY sin entidades", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const messageId = addPendingMessage(repo, conversationId, { kind: "call" });

    const result = await detectEntitiesForConversation(deps, { conversationId });

    expect(result.messagesProcessed).toBe(1);
    expect(ai.calls).toHaveLength(0);
    expect(repo.recordedEntities.get(messageId)).toEqual([]);
  });

  it("una respuesta malformada afecta solo a su grupo, no al resto del lote (SI-034)", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const brokenId = addPendingMessage(repo, conversationId, { content: "mensaje raro" });
    const okId = addPendingMessage(repo, conversationId, { content: "mensaje normal" });

    // aiBatchSize=1 => un grupo por mensaje, así se ve el aislamiento.
    ai.response = (prompt) =>
      prompt.includes("mensaje raro") ? "esto no es json" : emptyAnswerFor(prompt);

    const result = await detectEntitiesForConversation(deps, {
      conversationId,
      aiBatchSize: 1,
    });

    expect(result.messagesProcessed).toBe(1);
    expect(result.messagesFailed).toBe(1);
    expect(repo.processingStatus.get(okId)).toBe("ENTITY_READY");
    // El mensaje roto queda en METADATA_READY (no avanzó), listo para reintentar.
    expect(repo.processingStatus.get(brokenId)).toBe("METADATA_READY");
  });

  it("una respuesta malformada arrastra a todo su grupo, no solo a un mensaje", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const a = addPendingMessage(repo, conversationId, { content: "uno" });
    const b = addPendingMessage(repo, conversationId, { content: "dos" });
    ai.response = "esto no es json";

    const result = await detectEntitiesForConversation(deps, {
      conversationId,
      aiBatchSize: 2,
    });

    // Contrapartida asumida del batching: el radio de daño es el grupo.
    expect(result.messagesFailed).toBe(2);
    expect(repo.processingStatus.get(a)).toBe("METADATA_READY");
    expect(repo.processingStatus.get(b)).toBe("METADATA_READY");
  });

  it("un fallo sistémico del proveedor (ej. sin saldo) aborta la corrida en vez de tratarse como fallo por mensaje", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const first = addPendingMessage(repo, conversationId);
    addPendingMessage(repo, conversationId);
    ai.failWith = new Error(
      "400 Your credit balance is too low to access the Anthropic API"
    );

    await expect(
      detectEntitiesForConversation(deps, { conversationId })
    ).rejects.toThrow("credit balance");

    // No se registra como "fallo de mensaje" — la corrida entera se corta.
    expect(repo.processingStatus.get(first)).toBe("METADATA_READY");
  });

  it("no reintenta mensajes ya fallidos dentro de la misma corrida cuando fallos >= batchSize (evita loop infinito y gasto no acotado)", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    // batchSize=2 con 2 mensajes que fallan siempre: antes del fix,
    // fetched.length (2) nunca bajaba de batchSize (2) porque los
    // mensajes fallidos nunca salen de METADATA_READY, así que el loop
    // externo los volvía a traer y a reintentar contra la IA sin fin.
    const brokenA = addPendingMessage(repo, conversationId, { content: "roto A" });
    const brokenB = addPendingMessage(repo, conversationId, { content: "roto B" });
    ai.response = "esto no es json";

    const result = await Promise.race([
      detectEntitiesForConversation(deps, {
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
    // Un solo intento por mensaje contra la IA, no reintentos dentro de la corrida.
    expect(ai.calls).toHaveLength(2);
    expect(repo.processingStatus.get(brokenA)).toBe("METADATA_READY");
    expect(repo.processingStatus.get(brokenB)).toBe("METADATA_READY");
  });

  it("respeta maxMessages y deja el resto pendiente (control de gasto)", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 10; i += 1) addPendingMessage(repo, conversationId);

    const result = await detectEntitiesForConversation(deps, {
      conversationId,
      maxMessages: 3,
      aiBatchSize: 2,
    });

    expect(result.messagesProcessed).toBe(3);
    // Los 7 restantes siguen pendientes para una corrida futura: el
    // límite acota el gasto, no descarta trabajo.
    const pendientes = [...repo.processingStatus.values()].filter(
      (s) => s === "METADATA_READY"
    );
    expect(pendientes).toHaveLength(7);
  });

  it("reporta los tokens consumidos para poder registrar el costo real", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);
    const seen: unknown[] = [];
    deps.onUsage = (u) => seen.push(u);

    await detectEntitiesForConversation(deps, { conversationId });

    // El fake no invoca onUsage, pero el caso de uso debe haberlo
    // reenviado al proveedor — sin eso, rules/ai-cost.md regla 5 (costo
    // real observado) no se puede cumplir.
    const ai = deps.aiProvider as unknown as FakeAIProvider;
    expect(ai.calls[0]?.opts?.onUsage).toBe(deps.onUsage);
  });

  it("rechaza un aiBatchSize no positivo en vez de colgarse", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addPendingMessage(repo, conversationId);

    // Con size 0 el troceo no avanzaría y el proceso colgaría llenando
    // memoria en silencio, dentro del pipeline que gasta saldo.
    await expect(
      detectEntitiesForConversation(deps, { conversationId, aiBatchSize: 0 })
    ).rejects.toThrow(/aiBatchSize/);
    expect(ai.calls).toHaveLength(0);
  });

  it("pide suficientes tokens de salida para el tamaño del grupo", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 4; i += 1) addPendingMessage(repo, conversationId);

    await detectEntitiesForConversation(deps, { conversationId, aiBatchSize: 4 });

    // Quedarse corto trunca la respuesta y hace fallar el grupo entero
    // DESPUÉS de haberlo pagado.
    const maxTokens = ai.calls[0]?.opts?.maxTokens ?? 0;
    expect(maxTokens).toBeGreaterThanOrEqual(4 * 150);
  });
});
