// Integration test de UC-014: cubre la "definición de hecho" de
// plans/ — las preguntas de ejemplo devuelven respuesta +
// evidencia sobre datos de prueba, y una pregunta sin evidencia
// suficiente devuelve "no puedo responder" en vez de una respuesta
// inventada.
//
// Necesita base de datos real porque el paso de Evidence Retrieval usa
// las consultas del Search Layer (SQL). La IA sí es un fake determinista:
// ninguna corrida toca la API real (rules/ai-cost.md regla 1). Fixtures
// inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AIProvider,
  CompletionOptions,
  EmbeddingBatchOptions,
  EmbeddingBatchProvider,
  EmbeddingOptions,
} from "../../infrastructure/ai/provider.js";
import { testDb } from "../../infrastructure/db/test-client.js";
import {
  cases,
  conversations,
  embeddings,
  eventMessages,
  events,
  messages,
  participants,
} from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { GENERIC_PROFILE } from "../../shared/generic-profile.js";
import { answerQuestion } from "./answer-question.js";

const SEMANTIC_MODEL = "voyage-3-large";
const SEMANTIC_DIMS = 1024;

/** Vector unitario: siempre "el más parecido a sí mismo" contra el mismo vector de consulta. */
function basisVector(index: number): number[] {
  const v = new Array(SEMANTIC_DIMS).fill(0);
  v[index] = 1;
  return v;
}

/** No llama a Voyage: devuelve siempre el mismo vector fijo, sin depender de la red (rules/ai-cost.md). */
class FakeEmbeddingBatchProvider implements EmbeddingBatchProvider {
  constructor(private readonly vector: number[]) {}
  async embedBatch(
    texts: string[],
    _opts: EmbeddingBatchOptions
  ): Promise<number[][]> {
    return texts.map(() => this.vector);
  }
}

/**
 * Devuelve una respuesta distinta según qué prompt recibe: el primero es
 * el de detección de intent, el segundo el de generación de respuesta.
 */
class ScriptedAIProvider implements AIProvider {
  prompts: string[] = [];
  constructor(
    private readonly intentResponse: unknown,
    private readonly answerResponse: unknown = null
  ) {}

  async complete(prompt: string, _opts?: CompletionOptions): Promise<string> {
    this.prompts.push(prompt);
    const esIntent = prompt.includes("Clasificá la siguiente pregunta");
    return JSON.stringify(esIntent ? this.intentResponse : this.answerResponse);
  }
  async embed(_t: string, _o?: EmbeddingOptions): Promise<number[]> {
    throw new Error("no usado");
  }
}

interface Fixture {
  conversationId: string;
  messageIds: string[];
  eventId: string;
}

async function seed(): Promise<Fixture> {
  const [conversation] = await testDb
    .insert(conversations)
    .values({ title: null })
    .returning({ id: conversations.id });
  const conversationId = conversation!.id;
  const [ana] = await testDb
    .insert(participants)
    .values({ conversationId, displayName: "Ana", role: "desconocido" })
    .returning({ id: participants.id });

  const textos = [
    { sentAt: "2025-03-10T09:00:00Z", content: "propongo cambiar el horario del sábado" },
    { sentAt: "2025-03-12T10:00:00Z", content: "hablamos del teatro la semana próxima" },
  ];
  const messageIds: string[] = [];
  for (const t of textos) {
    const [row] = await testDb
      .insert(messages)
      .values({
        conversationId,
        participantId: ana!.id,
        sentAt: new Date(t.sentAt),
        content: t.content,
        kind: "text",
        rawSource: t.content,
        status: "PERSISTED",
        contentHash: randomUUID(),
      })
      .returning({ id: messages.id });
    messageIds.push(row!.id);
  }

  const [caso] = await testDb
    .insert(cases)
    .values({ conversationId, title: "cambios de horario", category: "planes" })
    .returning({ id: cases.id });
  const [evento] = await testDb
    .insert(events)
    .values({
      caseId: caso!.id,
      type: "cambio_horario",
      occurredAt: new Date("2025-03-10T09:00:00Z"),
    })
    .returning({ id: events.id });
  await testDb
    .insert(eventMessages)
    .values({ eventId: evento!.id, messageId: messageIds[0]! });

  return { conversationId, messageIds, eventId: evento!.id };
}

describe("answerQuestion (UC-014, Pipeline 12)", () => {
  let f: Fixture;
  beforeEach(async () => {
    await resetTestDatabase();
    f = await seed();
  });

  it("responde con evidencia y marca la respuesta como verificada", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_texto", text: "horario" },
      {
        answer: "Se propuso cambiar el horario del sábado.",
        sufficient_evidence: true,
        claims: [
          { statement: "Se propuso cambiar el horario del sábado.", evidence_indices: [1] },
        ],
      }
    );

    const result = await answerQuestion(
      {
        aiProvider: ai,
        profile: GENERIC_PROFILE,
        db: testDb,
        now: () => new Date("2025-06-15T00:00:00Z"),
      },
      { conversationId: f.conversationId, question: "¿cuántas veces cambiamos el horario?" }
    );

    expect(result.verified).toBe(true);
    expect(result.claims[0]?.evidenceIds).toEqual([f.messageIds[0]]);
    expect(result.context[0]?.sourceId).toBe(f.messageIds[0]);
  });

  it("marca como NO verificada una respuesta que cita evidencia inexistente", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_texto", text: "horario" },
      {
        answer: "Discutieron mucho por el horario.",
        sufficient_evidence: true,
        // El modelo dice tener evidencia suficiente, pero cita un índice
        // que nunca se le entregó.
        claims: [{ statement: "Discutieron mucho.", evidence_indices: [42] }],
      }
    );

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿discutieron?" }
    );

    // Que el modelo declare evidencia suficiente no alcanza: la
    // validación determinista manda.
    expect(result.verified).toBe(false);
    expect(result.claims[0]?.supported).toBe(false);
  });

  it("no da por buena una respuesta cuando el modelo admite falta de evidencia", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_texto", text: "horario" },
      {
        answer: "No hay suficiente información.",
        sufficient_evidence: false,
        claims: [{ statement: "Se mencionó el horario.", evidence_indices: [1] }],
      }
    );

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿por qué cambiaron el horario?" }
    );
    expect(result.verified).toBe(false);
  });

  it("responde 'no puedo responder' ante un intent no soportado, sin llamar al modelo de respuesta", async () => {
    const ai = new ScriptedAIProvider({
      intent: "no_soportado",
      reason: "requiere entender el significado de los mensajes",
    });

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿cuándo se enojó?" }
    );

    expect(result.verified).toBe(false);
    expect(result.answer).toContain("No puedo responder");
    expect(result.answer).toContain("significado");
    // Una sola llamada: no se paga la generación de una respuesta que ya
    // se sabe que no se puede fundamentar.
    expect(ai.prompts).toHaveLength(1);
  });

  it("no llama al modelo de respuesta cuando la búsqueda no recuperó nada", async () => {
    const ai = new ScriptedAIProvider({
      intent: "buscar_por_fecha",
      date: "2030-01-01",
    });

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿qué pasó el 1 de enero de 2030?" }
    );

    expect(result.answer).toBe("No puedo responder esa pregunta con la evidencia disponible.");
    expect(result.context).toEqual([]);
    // Sin evidencia, pedirle una respuesta al modelo es invitarlo a
    // inventarla (y pagar por ello).
    expect(ai.prompts).toHaveLength(1);
  });

  it("pasa el conteo real de coincidencias, no la longitud de la lista acotada", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_texto", text: "teatro" },
      { answer: "x", sufficient_evidence: true, claims: [{ statement: "x", evidence_indices: [1] }] }
    );

    await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      {
        conversationId: f.conversationId,
        question: "¿cuántas veces hablamos del teatro?",
        maxContextItems: 1,
      }
    );

    // El prompt de respuesta recibe el total de la base; contar la lista
    // daría un número falso cuando está recortada.
    const answerPrompt = ai.prompts[1] ?? "";
    expect(answerPrompt).toContain("Coincidencias totales en la conversación: 1");
  });

  it("una respuesta estadística exacta puede quedar verificada", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "estadisticas" },
      {
        answer: "La conversación tiene 2 mensajes.",
        sufficient_evidence: true,
        claims: [{ statement: "Hay 2 mensajes.", evidence_indices: [1] }],
      }
    );

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿cuántos mensajes hay?" }
    );

    expect(result.context[0]?.sourceType).toBe("Statistic");
    expect(result.context[0]?.text).toContain("2 mensajes");
    // Un conteo agregado no se prueba con un mensaje concreto, pero es
    // verificable recalculándolo. Marcarlo como no respaldado enseñaría
    // al usuario a ignorar el aviso justo cuando sí importa.
    expect(result.verified).toBe(true);
  });

  it("no llama al modelo cuando no hay ningún tema que coincida", async () => {
    const ai = new ScriptedAIProvider({ intent: "sobre_un_case", text: "hipoteca" });

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿qué pasó con la hipoteca?" }
    );

    expect(result.answer).toContain("No puedo responder");
    // La nota explica por qué, pero no justifica pagar una llamada sin
    // nada que citar.
    expect(result.answer).toContain("No se encontró ningún tema");
    expect(ai.prompts).toHaveLength(1);
  });

  it("recupera la cronología de eventos para un intent de cronología", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "cronologia", from: "2025-03-01", to: "2025-03-31" },
      {
        answer: "Hubo un cambio de horario.",
        sufficient_evidence: true,
        claims: [{ statement: "Hubo un cambio de horario.", evidence_indices: [1] }],
      }
    );

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      { conversationId: f.conversationId, question: "¿qué pasó en marzo?" }
    );

    expect(result.context[0]?.sourceType).toBe("Event");
    expect(result.context[0]?.sourceId).toBe(f.eventId);
    expect(result.claims[0]?.evidenceIds).toEqual([f.eventId]);
  });

  it("avisa al modelo cuando la evidencia viene recortada", async () => {
    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_rango", from: "2025-01-01", to: "2025-12-31" },
      { answer: "x", sufficient_evidence: true, claims: [{ statement: "x", evidence_indices: [1] }] }
    );

    const result = await answerQuestion(
      { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
      {
        conversationId: f.conversationId,
        question: "¿qué se dijo en 2025?",
        maxContextItems: 1,
      }
    );

    expect(result.evidenceTruncated).toBe(true);
    // Sin este aviso el modelo respondería como si esa fuera toda la
    // evidencia existente.
    expect(ai.prompts[1]).toContain("recortada");
  });

  it("recupera evidencia por similitud semántica para el intent buscar_por_tema", async () => {
    await testDb.insert(embeddings).values({
      subjectType: "Message",
      subjectId: f.messageIds[1]!,
      model: SEMANTIC_MODEL,
      dims: SEMANTIC_DIMS,
      vector: basisVector(0),
      generatedAt: new Date(),
    });

    const ai = new ScriptedAIProvider(
      { intent: "buscar_por_tema", text: "teatro" },
      {
        answer: "Se habló del teatro.",
        sufficient_evidence: true,
        claims: [{ statement: "Se habló del teatro.", evidence_indices: [1] }],
      }
    );

    const result = await answerQuestion(
      {
        aiProvider: ai,
        profile: GENERIC_PROFILE,
        db: testDb,
        semanticSearch: {
          embeddingProvider: new FakeEmbeddingBatchProvider(basisVector(0)),
          model: SEMANTIC_MODEL,
          dims: SEMANTIC_DIMS,
        },
      },
      {
        conversationId: f.conversationId,
        question: "¿de qué hablamos relacionado con el espectáculo?",
      }
    );

    expect(result.context[0]?.sourceType).toBe("Message");
    expect(result.context[0]?.sourceId).toBe(f.messageIds[1]);
    expect(result.verified).toBe(true);
    // Trazabilidad: el `text` de un resultado semántico agrupa varios
    // mensajes con fechas distintas, y `sentAt` es solo la del ancla. Sin
    // `windowMessages` no hay forma de volver al historial y ubicar los
    // mensajes de contexto por fecha — se perdería en silencio.
    const ventana = result.context[0]?.windowMessages;
    expect(ventana).toBeDefined();
    expect(ventana!.length).toBeGreaterThan(0);
    expect(ventana!.at(-1)?.messageId).toBe(f.messageIds[1]);
    for (const m of ventana!) {
      expect(m.sentAt).toBeInstanceOf(Date);
    }
    // El prompt de respuesta debe avisar que es similitud, no búsqueda
    // literal (SI-036) — el modelo tiene que calibrar su confianza distinto.
    expect(ai.prompts[1]).toContain("similitud semántica");
  });

  it("falla explícito si buscar_por_tema no tiene deps.semanticSearch configurado", async () => {
    const ai = new ScriptedAIProvider({ intent: "buscar_por_tema", text: "teatro" });

    // Sin default silencioso (mismo criterio que EMBEDDING_MODEL/
    // EMBEDDING_DIMENSIONS en cli-embed.ts): mejor un error explícito que
    // una respuesta "no puedo responder" que parezca falta de evidencia.
    await expect(
      answerQuestion(
        { aiProvider: ai, profile: GENERIC_PROFILE, db: testDb },
        {
          conversationId: f.conversationId,
          question: "¿de qué hablamos relacionado con el espectáculo?",
        }
      )
    ).rejects.toThrow("semanticSearch");
  });
});
