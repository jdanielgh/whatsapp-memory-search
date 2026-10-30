// Tests de Pipelines 5+6 (rules/dev-style.md). Sin llamadas a la API
// real (rules/ai-cost.md): AIProvider fake determinista. Fixtures
// inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AIProvider,
  CompletionOptions,
  EmbeddingOptions,
} from "../../infrastructure/ai/provider.js";
import { GENERIC_PROFILE } from "../../shared/generic-profile.js";
import type { OpenCaseSummary } from "../domain/case-resolution.js";
import type {
  CaseRepository,
  MessageForEventDetection,
  RecordEventDetectionInput,
} from "../repositories/case-repository.js";
import { detectEventsForConversation, type DetectEventsDeps } from "./detect-events.js";

class FakeAIProvider implements AIProvider {
  calls: Array<{ prompt: string; opts?: CompletionOptions }> = [];
  response: string | ((prompt: string) => string) = JSON.stringify({ events: [] });
  failWith: Error | null = null;
  model = "modelo-de-prueba";

  async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    if (this.failWith) throw this.failWith;
    opts?.onUsage?.({
      model: this.model,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
    });
    return typeof this.response === "function" ? this.response(prompt) : this.response;
  }

  async embed(_t: string, _o?: EmbeddingOptions): Promise<number[]> {
    throw new Error("no usado");
  }
}

class FakeCaseRepository implements CaseRepository {
  messages: Array<MessageForEventDetection & { conversationId: string }> = [];
  status = new Map<string, string>();
  openCases: OpenCaseSummary[] = [];
  recorded: RecordEventDetectionInput[] = [];
  private caseSeq = 0;

  async findMessagesPendingEventDetection(conversationId: string, limit: number) {
    return this.messages
      .filter(
        (m) => m.conversationId === conversationId && this.status.get(m.id) === "ENTITY_READY"
      )
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(0, limit)
      .map(({ conversationId: _c, ...rest }) => rest);
  }

  async findOpenCases(_conversationId: string) {
    return [...this.openCases];
  }

  async recordEventDetection(input: RecordEventDetectionInput) {
    this.recorded.push(input);
    // Deduplica por (categoría, título) igual que la implementación real:
    // si el fake no lo hiciera, los tests no verían el bug que esa
    // deduplicación evita.
    const creadosEnEstaLlamada = new Map<string, string>();
    for (const event of input.events) {
      if (event.messageIds.length === 0) {
        throw new Error("Event sin mensajes de respaldo (SI-014).");
      }
      if (event.target.kind === "existing") continue;

      const clave = `${event.target.category} ${event.target.title}`;
      if (creadosEnEstaLlamada.has(clave)) continue;
      this.caseSeq += 1;
      const id = `caso-${this.caseSeq}`;
      creadosEnEstaLlamada.set(clave, id);
      this.openCases.push({
        id,
        title: event.target.title,
        category: event.target.category,
        lastEventAt: event.occurredAt,
      });
    }
    for (const id of input.processedMessageIds) this.status.set(id, "CASE_READY");
  }
}

function makeDeps(): { deps: DetectEventsDeps; repo: FakeCaseRepository; ai: FakeAIProvider } {
  const repo = new FakeCaseRepository();
  const ai = new FakeAIProvider();
  return {
    deps: { caseRepo: repo, aiProvider: ai, audit: async () => {}, profile: GENERIC_PROFILE },
    repo,
    ai,
  };
}

let clock = 0;
function addMessage(
  repo: FakeCaseRepository,
  conversationId: string,
  overrides: Partial<MessageForEventDetection> = {}
): string {
  const id = randomUUID();
  clock += 1;
  repo.messages.push({
    id,
    conversationId,
    content: overrides.content ?? "hola",
    kind: overrides.kind ?? "text",
    participantId: overrides.participantId ?? "p1",
    sentAt: overrides.sentAt ?? new Date(Date.UTC(2025, 2, 10, 0, clock)),
  });
  repo.status.set(id, "ENTITY_READY");
  return id;
}

const evento = (indices: number[], overrides: Record<string, unknown> = {}) => ({
  type: "propuesta",
  category: "planes",
  title: "recogida del sábado",
  message_indices: indices,
  observation: "Se propone una recogida.",
  confidence: 0.9,
  ...overrides,
});

describe("detectEventsForConversation (Pipelines 5+6)", () => {
  it("persiste el evento con sus mensajes de respaldo y avanza a CASE_READY", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const a = addMessage(repo, conversationId);
    const b = addMessage(repo, conversationId);
    ai.response = JSON.stringify({ events: [evento([1, 2])] });

    const result = await detectEventsForConversation(deps, { conversationId });

    expect(result.eventsDetected).toBe(1);
    expect(result.casesCreated).toBe(1);
    expect(repo.status.get(a)).toBe("CASE_READY");
    expect(repo.status.get(b)).toBe("CASE_READY");
    expect(repo.recorded[0]?.events[0]?.messageIds).toEqual([a, b]);
    expect(ai.calls[0]?.opts?.tier).toBe("default");
  });

  it("analiza una ventana de varios mensajes en una sola llamada", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 6; i += 1) addMessage(repo, conversationId);

    const result = await detectEventsForConversation(deps, {
      conversationId,
      windowSize: 3,
    });

    expect(result.messagesProcessed).toBe(6);
    expect(result.aiCalls).toBe(2);
  });

  it("toma occurred_at de la evidencia, no de lo que diga el modelo", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const primero = new Date("2025-05-01T10:00:00Z");
    addMessage(repo, conversationId, { sentAt: primero });
    addMessage(repo, conversationId, { sentAt: new Date("2025-05-01T11:00:00Z") });
    // El modelo manda una fecha inventada, que debe ignorarse.
    ai.response = JSON.stringify({
      events: [evento([1, 2], { occurred_at: "1999-01-01T00:00:00Z" })],
    });

    await detectEventsForConversation(deps, { conversationId });

    // Una fecha inventada contaminaría la cronología de UC-012.
    expect(repo.recorded[0]?.events[0]?.occurredAt).toEqual(primero);
  });

  it("agrupa eventos del mismo tema en un solo Case a lo largo de varias ventanas", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 4; i += 1) addMessage(repo, conversationId);

    const { deps: _d, ai } = { deps, ai: deps.aiProvider as FakeAIProvider };
    ai.response = JSON.stringify({ events: [evento([1])] });

    const result = await detectEventsForConversation(deps, {
      conversationId,
      windowSize: 2,
    });

    // Dos ventanas, dos eventos del mismo tema: un solo Case. Sin el
    // refresco de Cases entre ventanas, cada una abriría el suyo y
    // UC-011 quedaría inservible.
    expect(result.aiCalls).toBe(2);
    expect(result.eventsDetected).toBe(2);
    expect(result.casesCreated).toBe(1);
    expect(repo.openCases).toHaveLength(1);
  });

  it("dos eventos del mismo tema en una ventana van a un solo Case", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId);
    addMessage(repo, conversationId);
    // Una propuesta y su aceptación: dos eventos, mismo asunto.
    ai.response = JSON.stringify({
      events: [
        evento([1]),
        evento([2], { type: "aceptación" }),
      ],
    });

    const result = await detectEventsForConversation(deps, { conversationId });

    expect(result.eventsDetected).toBe(2);
    // Ambos resuelven "Case nuevo" porque ninguno existía al empezar la
    // ventana; sin deduplicación se crearían dos Cases idénticos y UC-011
    // mostraría el asunto partido en dos.
    expect(result.casesCreated).toBe(1);
    expect(repo.openCases).toHaveLength(1);
  });

  it("mantiene vivo un Case existente al asociarle eventos nuevos", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    // El título del Case NO comparte palabras con el del evento, para que
    // el emparejamiento dependa de la cercanía temporal y no del título
    // (si no, el test pasaría por la otra vía y no probaría nada).
    repo.openCases.push({
      id: "caso-existente",
      title: "asunto previo sin relación",
      category: "planes",
      lastEventAt: new Date("2025-02-20T00:00:00Z"),
    });
    // 33 días después del último evento conocido: dentro de la ventana.
    addMessage(repo, conversationId, { sentAt: new Date("2025-03-25T00:00:00Z") });
    // 31 días después del anterior (dentro), pero 64 días después de
    // febrero (fuera): solo se agrupa si el primero refrescó la fecha.
    addMessage(repo, conversationId, { sentAt: new Date("2025-04-25T00:00:00Z") });
    ai.response = JSON.stringify({ events: [evento([1])] });

    // Las fechas de arriba están calibradas para una ventana de 45 días.
    const result = await detectEventsForConversation(
      { ...deps, profile: { ...GENERIC_PROFILE, caseContinuityDays: 45 } },
      { conversationId, windowSize: 1 }
    );

    // Si al asociar un evento no se refrescara lastEventAt en memoria, la
    // segunda ventana seguiría comparando contra enero, lo consideraría
    // inactivo y abriría un duplicado del mismo asunto.
    expect(result.eventsDetected).toBe(2);
    expect(result.casesCreated).toBe(0);
    expect(repo.openCases).toHaveLength(1);
  });

  it("registra el modelo que reportó el proveedor, no un valor fijo (SI-019)", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId);
    ai.model = "sonnet-de-prueba";
    ai.response = JSON.stringify({ events: [evento([1])] });

    await detectEventsForConversation(deps, { conversationId });

    expect(repo.recorded[0]?.model).toBe("sonnet-de-prueba");
    // Incluye el perfil de dominio: cambiarlo cambia el prompt (SI-020).
    expect(repo.recorded[0]?.promptVersion).toBe("event-detection-v2+generic@1");
  });

  it("una ventana sin eventos igual avanza de estado (no se reprocesa gratis)", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    const id = addMessage(repo, conversationId);

    const result = await detectEventsForConversation(deps, { conversationId });

    expect(result.eventsDetected).toBe(0);
    // "No hay eventos" es un resultado válido, distinto de "sin procesar".
    expect(repo.status.get(id)).toBe("CASE_READY");
  });

  it("es idempotente: reejecutar no vuelve a llamar a la IA", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId);

    await detectEventsForConversation(deps, { conversationId });
    const after = ai.calls.length;
    const second = await detectEventsForConversation(deps, { conversationId });

    expect(second.messagesProcessed).toBe(0);
    expect(ai.calls.length).toBe(after);
  });

  it("una respuesta inválida deja la ventana pendiente sin bloquear al resto", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const roto = addMessage(repo, conversationId, { content: "ventana rota" });
    const ok = addMessage(repo, conversationId, { content: "ventana sana" });
    ai.response = (prompt) =>
      prompt.includes("ventana rota") ? "no es json" : JSON.stringify({ events: [] });

    const result = await detectEventsForConversation(deps, {
      conversationId,
      windowSize: 1,
    });

    expect(result.messagesFailed).toBe(1);
    expect(repo.status.get(roto)).toBe("ENTITY_READY");
    expect(repo.status.get(ok)).toBe("CASE_READY");
  });

  it("un fallo sistémico del proveedor corta la corrida", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    const id = addMessage(repo, conversationId);
    ai.failWith = new Error("400 Your credit balance is too low");

    await expect(detectEventsForConversation(deps, { conversationId })).rejects.toThrow(
      "credit balance"
    );
    expect(repo.status.get(id)).toBe("ENTITY_READY");
  });

  it("respeta maxMessages (control de gasto)", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    for (let i = 0; i < 10; i += 1) addMessage(repo, conversationId);

    const result = await detectEventsForConversation(deps, {
      conversationId,
      maxMessages: 4,
      windowSize: 2,
    });

    expect(result.messagesProcessed).toBe(4);
    expect(
      [...repo.status.values()].filter((s) => s === "ENTITY_READY")
    ).toHaveLength(6);
  });

  it("no reintenta ventanas ya fallidas dentro de la misma corrida", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId);
    addMessage(repo, conversationId);
    ai.response = "no es json";

    const result = await Promise.race([
      detectEventsForConversation(deps, {
        conversationId,
        batchSize: 2,
        windowSize: 1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT: probable loop infinito")), 2000)
      ),
    ]);

    expect(result.messagesFailed).toBe(2);
    expect(ai.calls).toHaveLength(2);
  });

  it("rechaza windowSize no positivo en vez de colgarse", async () => {
    const { deps, repo } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId);

    await expect(
      detectEventsForConversation(deps, { conversationId, windowSize: 0 })
    ).rejects.toThrow(/windowSize/);
  });

  it("usa etiquetas neutrales en vez de identificadores de participante", async () => {
    const { deps, repo, ai } = makeDeps();
    const conversationId = randomUUID();
    addMessage(repo, conversationId, { participantId: "uuid-del-participante-a" });
    addMessage(repo, conversationId, { participantId: "uuid-del-participante-b" });

    await detectEventsForConversation(deps, { conversationId });

    const prompt = ai.calls[0]?.prompt ?? "";
    expect(prompt).toContain("Participante 1");
    expect(prompt).toContain("Participante 2");
    expect(prompt).not.toContain("uuid-del-participante-a");
  });
});
