// Integration test obligatorio (rules/dev-style.md regla 4: recuperación
// RAG) — el operador `<=>` de pgvector, el filtro `model`/`dims` y la
// reconstrucción de la ventana (join con `findPrecedingMessages`) son SQL
// real que un fake en memoria no puede validar. Corre contra la base de
// datos de test efímera (nunca la de desarrollo), con vectores fijos
// insertados directamente (SIN llamar a Voyage — rules/ai-cost.md).
// Fixtures inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import { conversations, embeddings, messages, participants } from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import type { EmbeddingBatchOptions, EmbeddingBatchProvider } from "../../infrastructure/ai/provider.js";
import {
  DEFAULT_SEMANTIC_TOP_K,
  findSimilarMessages,
  searchMessagesBySemanticSimilarity,
} from "./semantic-search.js";

const DIMS = 1024;
const MODEL = "voyage-3-large";

/** Vector unitario ortogonal — dos basisVector con índices distintos tienen similitud coseno 0, exactamente el mismo índice tiene similitud 1. */
function basisVector(index: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[index] = 1;
  return v;
}

/** Casi igual a `base` pero con un desvío chico — similitud alta pero no perfecta, para verificar el orden intermedio. */
function nearVector(index: number): number[] {
  const v = basisVector(index);
  v[(index + 1) % DIMS] = 0.2;
  return v;
}

async function seedFixture() {
  const [conversation] = await testDb
    .insert(conversations)
    .values({ title: null })
    .returning({ id: conversations.id });
  const [participant] = await testDb
    .insert(participants)
    .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
    .returning({ id: participants.id });

  async function seedMessage(content: string, sentAt: Date): Promise<string> {
    const [row] = await testDb
      .insert(messages)
      .values({
        conversationId: conversation!.id,
        participantId: participant!.id,
        sentAt,
        content,
        kind: "text",
        rawSource: content,
        status: "PERSISTED",
        contentHash: randomUUID(),
      })
      .returning({ id: messages.id });
    return row!.id;
  }

  async function seedMessageWithEmbedding(
    content: string,
    vector: number[],
    overrides: { model?: string; dims?: number; sentAt?: Date } = {}
  ) {
    const messageId = await seedMessage(content, overrides.sentAt ?? new Date("2025-03-01T10:00:00Z"));
    await testDb.insert(embeddings).values({
      subjectType: "Message",
      subjectId: messageId,
      model: overrides.model ?? MODEL,
      dims: overrides.dims ?? DIMS,
      vector,
      generatedAt: new Date(),
    });
    return messageId;
  }

  return { conversationId: conversation!.id, seedMessage, seedMessageWithEmbedding };
}

describe("Semantic Search (Q-SEM-01, integration)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("ordena por similitud coseno descendente, con el mensaje idéntico primero", async () => {
    const { conversationId, seedMessage, seedMessageWithEmbedding } = await seedFixture();
    let minute = 0;
    const nextTime = () => new Date(`2025-03-01T10:${String(minute++).padStart(2, "0")}:00Z`);

    // Separados por relleno para que sus ventanas no se solapen entre sí
    // — este test verifica orden por score, no deduplicación (que tiene
    // su propio test dedicado).
    const identical = await seedMessageWithEmbedding("mensaje idéntico a la consulta", basisVector(0), {
      sentAt: nextTime(),
    });
    await seedMessage("relleno a", nextTime());
    await seedMessage("relleno b", nextTime());
    const near = await seedMessageWithEmbedding("mensaje parecido", nearVector(0), { sentAt: nextTime() });
    await seedMessage("relleno c", nextTime());
    await seedMessage("relleno d", nextTime());
    const unrelated = await seedMessageWithEmbedding("mensaje sin relación", basisVector(1), {
      sentAt: nextTime(),
    });

    const results = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(results.map((r) => r.messageId)).toEqual([identical, near, unrelated]);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    // SI-037: siempre viene el message_id de origen, no solo el score.
    expect(results.every((r) => typeof r.messageId === "string" && r.messageId.length > 0)).toBe(true);
  });

  it("SI-037: cada resultado trae content y sentAt, reconstruibles a evidencia", async () => {
    const { conversationId, seedMessageWithEmbedding } = await seedFixture();
    await seedMessageWithEmbedding("hola, nos vemos el sábado", basisVector(0));

    const [result] = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(result?.content).toBe("hola, nos vemos el sábado");
    expect(result?.sentAt).toBeInstanceOf(Date);
  });

  it("sin mensajes previos en el hilo, la ventana es solo el ancla etiquetado y contextMessageIds queda vacío", async () => {
    const { conversationId, seedMessageWithEmbedding } = await seedFixture();
    await seedMessageWithEmbedding("hola, nos vemos el sábado", basisVector(0));

    const [result] = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(result?.contextMessageIds).toEqual([]);
    expect(result?.windowContent).toBe("Participante 1: hola, nos vemos el sábado");
  });

  it("la ventana devuelta incluye el contexto previo que realmente se embebió, no solo el ancla (docs/DECISIONS.md)", async () => {
    const { conversationId, seedMessage, seedMessageWithEmbedding } = await seedFixture();
    const previo1 = await seedMessage("te va bien el sábado?", new Date("2025-03-01T10:00:00Z"));
    const previo2 = await seedMessage("sí, a qué hora", new Date("2025-03-01T10:01:00Z"));
    // El ancla ("dale") es ambiguo aislado — la ventana es lo que justifica el score.
    const ancla = await seedMessageWithEmbedding("dale", basisVector(0), {
      sentAt: new Date("2025-03-01T10:02:00Z"),
    });

    const [result] = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(result?.messageId).toBe(ancla);
    expect(result?.content).toBe("dale"); // el ancla a solas sigue disponible
    expect(result?.contextMessageIds).toEqual([previo1, previo2]);
    expect(result?.windowContent).toBe(
      "Participante 1: te va bien el sábado?\nParticipante 1: sí, a qué hora\nParticipante 1: dale"
    );
  });

  it("deduplica ventanas solapadas: un intercambio no consume varios lugares del top-k (caso real: 'Listo' top-5 con score 0,567, docs/DECISIONS.md)", async () => {
    const { conversationId, seedMessage, seedMessageWithEmbedding } = await seedFixture();
    const t = (m: number) => new Date(`2025-03-01T10:${String(m).padStart(2, "0")}:00Z`);

    // Cadena de 4 mensajes consecutivos: m1 (sin embedding, solo contexto),
    // m2/m3/m4 con embedding. CONTEXT_WINDOW_SIZE=2, así que:
    //   ventana(m2) = {m1, m2}
    //   ventana(m3) = {m1, m2, m3}
    //   ventana(m4) = {m2, m3, m4}
    // Las tres se solapan entre sí (comparten al menos un mensaje) — un
    // solo intercambio real.
    const m1 = await seedMessage("te queda bien el jueves?", t(0));
    const m2 = await seedMessageWithEmbedding("a qué hora salís", nearVector(0), { sentAt: t(1) });
    const m3 = await seedMessageWithEmbedding("dale, nos vemos ahí", basisVector(0), { sentAt: t(2) }); // score más alto: 1.0
    const m4 = await seedMessageWithEmbedding("listo", nearVector(0), { sentAt: t(3) });

    // Mensaje genuinamente distinto, con su propio contexto sin solapar
    // con la cadena de arriba (separado por dos mensajes de relleno).
    const gap1 = await seedMessage("relleno 1", t(4));
    const gap2 = await seedMessage("relleno 2", t(5));
    const m5 = await seedMessageWithEmbedding("otro tema sin relación", nearVector(2), { sentAt: t(6) });

    const results = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS, topK: 3 },
      testDb
    );

    // De los 4 candidatos de la cadena (m2, m3, m4) solo sobrevive el de
    // mayor score (m3); m5 es un grupo distinto y también sobrevive. Solo
    // hay 2 grupos reales entre los 4 embeddings sembrados, aunque se pidió
    // topK=3 — mejor devolver menos resultados que rellenar con
    // redundancia.
    expect(results.map((r) => r.messageId)).toEqual([m3, m5]);
    expect(results[0]?.contextMessageIds).toEqual([m1, m2]);
    expect(results[1]?.contextMessageIds).toEqual([gap1, gap2]);

    // Ningún messageId de la cadena descartada (m2, m4) aparece como
    // resultado de primer nivel — sigue viviendo solo como contexto de m3.
    expect(results.map((r) => r.messageId)).not.toContain(m2);
    expect(results.map((r) => r.messageId)).not.toContain(m4);
  });

  it("no mezcla embeddings de otro modelo/dimensión (SI-028: conviven varias generaciones en la tabla)", async () => {
    const { conversationId, seedMessageWithEmbedding } = await seedFixture();
    await seedMessageWithEmbedding("del modelo vigente", basisVector(0));
    await seedMessageWithEmbedding("de un modelo viejo", basisVector(0), { model: "voyage-2" });

    const results = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(results).toHaveLength(1);
  });

  it("no cruza mensajes de otra Conversation", async () => {
    const fixtureA = await seedFixture();
    const fixtureB = await seedFixture();
    await fixtureA.seedMessageWithEmbedding("de A", basisVector(0));
    await fixtureB.seedMessageWithEmbedding("de B", basisVector(0));

    const results = await findSimilarMessages(
      { conversationId: fixtureA.conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("de A");
  });

  it("respeta topK, y el default es bajo (docs/DECISIONS.md)", async () => {
    expect(DEFAULT_SEMANTIC_TOP_K).toBeLessThanOrEqual(5);

    const { conversationId, seedMessage, seedMessageWithEmbedding } = await seedFixture();
    let minute = 0;
    const nextTime = () => new Date(`2025-03-01T10:${String(minute++).padStart(2, "0")}:00Z`);

    // 8 mensajes con embedding, cada uno separado por 2 mensajes de
    // relleno (sin embedding) — así ninguna ventana (CONTEXT_WINDOW_SIZE=2)
    // llega a otro candidato y el dedup no reduce el conteo. Esto prueba
    // topK de forma aislada, sin depender del criterio de solapamiento
    // (que ya tiene su propio test arriba).
    for (let i = 0; i < 8; i += 1) {
      await seedMessage(`relleno ${i}a`, nextTime());
      await seedMessage(`relleno ${i}b`, nextTime());
      await seedMessageWithEmbedding(`mensaje ${i}`, basisVector(0), { sentAt: nextTime() });
    }

    const results = await findSimilarMessages(
      { conversationId, queryVector: basisVector(0), model: MODEL, dims: DIMS, topK: 3 },
      testDb
    );

    expect(results).toHaveLength(3);
  });

  it("searchMessagesBySemanticSimilarity embebe la consulta con inputType 'query', no 'document'", async () => {
    const { conversationId, seedMessageWithEmbedding } = await seedFixture();
    const target = await seedMessageWithEmbedding("dale, nos vemos el sábado", basisVector(0));

    const calls: Array<{ texts: string[]; opts: EmbeddingBatchOptions }> = [];
    const fakeProvider: EmbeddingBatchProvider = {
      async embedBatch(texts, opts) {
        calls.push({ texts, opts });
        return [basisVector(0)];
      },
    };

    const results = await searchMessagesBySemanticSimilarity(
      { conversationId, queryText: "¿confirmaste el plan del sábado?", model: MODEL, dims: DIMS },
      { embeddingProvider: fakeProvider },
      testDb
    );

    expect(calls[0]?.opts.inputType).toBe("query");
    expect(calls[0]?.texts).toEqual(["¿confirmaste el plan del sábado?"]);
    expect(results[0]?.messageId).toBe(target);
  });

  // Regresión de un bug encontrado sobre el corpus real: con etiquetas
  // numeradas por orden de aparición DENTRO de cada ventana,
  // "Participante 1" eran dos personas distintas en un mismo conjunto de
  // resultados. Concatenar esas ventanas en un prompt haría que el LLM
  // atribuyera frases a quien no las dijo (rules/security-privacy.md
  // regla 7: la conversación podría usarse como evidencia).
  it("etiqueta al mismo participante igual en todas las ventanas, aunque cada una empiece con otro hablante", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const inserted = await testDb
      .insert(participants)
      .values([
        { conversationId: conversation!.id, displayName: "Ana", role: "desconocido" },
        { conversationId: conversation!.id, displayName: "Beto", role: "desconocido" },
      ])
      .returning({ id: participants.id });
    const [ana, beto] = inserted as [{ id: string }, { id: string }];

    let minute = 0;
    async function seed(participantId: string, content: string): Promise<string> {
      const [row] = await testDb
        .insert(messages)
        .values({
          conversationId: conversation!.id,
          participantId,
          sentAt: new Date(`2025-03-01T10:${String(minute++).padStart(2, "0")}:00Z`),
          content,
          kind: "text",
          rawSource: content,
          status: "PERSISTED",
          contentHash: randomUUID(),
        })
        .returning({ id: messages.id });
      return row!.id;
    }
    async function seedWithEmbedding(
      participantId: string,
      content: string,
      vector: number[]
    ): Promise<string> {
      const messageId = await seed(participantId, content);
      await testDb.insert(embeddings).values({
        subjectType: "Message",
        subjectId: messageId,
        model: MODEL,
        dims: DIMS,
        vector,
        generatedAt: new Date(),
      });
      return messageId;
    }

    // Ana habla primero en la Conversation -> le toca "Participante 1"
    // de forma estable, sin importar quién abra cada ventana.
    await seed(ana.id, "arranca la conversación");

    // Ventana 1: la abre Beto. Con etiquetado local, Beto sería aquí
    // "Participante 1".
    await seed(beto.id, "yo llevo las entradas");
    await seed(ana.id, "dale");
    const anclaUno = await seedWithEmbedding(beto.id, "confirmado", basisVector(0));

    // Relleno para que las dos ventanas no se solapen (si no, el dedup
    // descartaría la segunda y el test no probaría nada).
    await seed(ana.id, "relleno a");
    await seed(ana.id, "relleno b");

    // Ventana 2: la abre Ana. Con etiquetado local, Ana también sería
    // "Participante 1" -> la colisión.
    await seed(ana.id, "cambio de horario");
    await seed(beto.id, "ok");
    const anclaDos = await seedWithEmbedding(ana.id, "listo entonces", nearVector(0));

    const results = await findSimilarMessages(
      { conversationId: conversation!.id, queryVector: basisVector(0), model: MODEL, dims: DIMS },
      testDb
    );

    expect(results.map((r) => r.messageId)).toEqual([anclaUno, anclaDos]);

    // La misma persona recibe la misma etiqueta en ventanas distintas.
    const etiquetasPorParticipante = new Map<string, Set<string>>();
    for (const result of results) {
      for (const m of result.windowMessages) {
        const set = etiquetasPorParticipante.get(m.participantId) ?? new Set<string>();
        set.add(m.speakerLabel);
        etiquetasPorParticipante.set(m.participantId, set);
      }
    }
    for (const [, etiquetas] of etiquetasPorParticipante) {
      expect([...etiquetas]).toHaveLength(1);
    }

    // Y a la inversa: una etiqueta nunca designa a dos personas.
    const participantesPorEtiqueta = new Map<string, Set<string>>();
    for (const result of results) {
      for (const m of result.windowMessages) {
        const set = participantesPorEtiqueta.get(m.speakerLabel) ?? new Set<string>();
        set.add(m.participantId);
        participantesPorEtiqueta.set(m.speakerLabel, set);
      }
    }
    for (const [, personas] of participantesPorEtiqueta) {
      expect([...personas]).toHaveLength(1);
    }

    // Ana abrió la Conversation, así que es Participante 1 en ambas
    // ventanas — incluso en la primera, que empieza hablando Beto.
    const etiquetaDeAna = [...(etiquetasPorParticipante.get(ana.id) ?? [])][0];
    const etiquetaDeBeto = [...(etiquetasPorParticipante.get(beto.id) ?? [])][0];
    expect(etiquetaDeAna).toBe("Participante 1");
    expect(etiquetaDeBeto).toBe("Participante 2");
    expect(results[0]!.windowContent.startsWith("Participante 2:")).toBe(true);

    // El ancla siempre va al final de su ventana y es el único marcado.
    for (const result of results) {
      const anchors = result.windowMessages.filter((m) => m.isAnchor);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.messageId).toBe(result.messageId);
      expect(result.windowMessages.at(-1)!.isAnchor).toBe(true);
    }
  });
});
