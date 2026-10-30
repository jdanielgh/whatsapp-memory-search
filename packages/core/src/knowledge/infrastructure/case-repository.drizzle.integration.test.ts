// Integration test obligatorio (rules/dev-style.md, regla 4, ampliada a
// cualquier código que interactúe con Postgres real). Acá importa más
// que en otros repositorios: recordEventDetection escribe cinco tablas
// en una transacción (cases, events, event_messages, analyses,
// observations) más el avance de estado, y findOpenCases usa un
// leftJoin+groupBy+max que un fake en memoria no puede validar. Un error
// de SQL acá dejaría Events sin evidencia (SI-014) o Cases duplicados.
// Corre contra la base de datos de test efímera, nunca la de desarrollo.
// Fixtures inventados (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import {
  analyses,
  cases,
  eventMessages,
  events,
  messageProcessingState,
  messages,
  observations,
  conversations,
  participants,
} from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { DrizzleCaseRepository } from "./case-repository.drizzle.js";

const repo = new DrizzleCaseRepository(testDb);

async function seedConversation() {
  const [conversation] = await testDb
    .insert(conversations)
    .values({ title: null })
    .returning({ id: conversations.id });
  const [participant] = await testDb
    .insert(participants)
    .values({
      conversationId: conversation!.id,
      displayName: "Participante de prueba",
      role: "desconocido",
    })
    .returning({ id: participants.id });
  return { conversationId: conversation!.id, participantId: participant!.id };
}

async function seedMessage(
  conversationId: string,
  participantId: string,
  sentAt: Date,
  status = "ENTITY_READY"
) {
  const [row] = await testDb
    .insert(messages)
    .values({
      conversationId,
      participantId,
      sentAt,
      content: "contenido inventado",
      kind: "text",
      rawSource: "contenido inventado",
      status: "PERSISTED",
      contentHash: randomUUID(),
    })
    .returning({ id: messages.id });
  await testDb
    .insert(messageProcessingState)
    .values({ messageId: row!.id, status });
  return row!.id;
}

describe("DrizzleCaseRepository (integration)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("devuelve los mensajes pendientes en orden cronológico", async () => {
    const { conversationId, participantId } = await seedConversation();
    // Se insertan desordenados a propósito: la ventana de análisis es
    // conversacional y un orden equivocado destruiría el contexto que
    // hace detectable un par propuesta/respuesta.
    const tarde = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T12:00:00Z")
    );
    const temprano = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z")
    );

    const pending = await repo.findMessagesPendingEventDetection(conversationId, 10);

    expect(pending.map((m) => m.id)).toEqual([temprano, tarde]);
  });

  it("ignora mensajes que todavía no llegaron a ENTITY_READY", async () => {
    const { conversationId, participantId } = await seedConversation();
    await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z"),
      "METADATA_READY"
    );

    expect(await repo.findMessagesPendingEventDetection(conversationId, 10)).toEqual([]);
  });

  it("persiste Case, Event, evidencia, Analysis y Observation en una sola escritura", async () => {
    const { conversationId, participantId } = await seedConversation();
    const messageId = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z")
    );

    await repo.recordEventDetection({
      conversationId,
      processedMessageIds: [messageId],
      model: "modelo-de-prueba",
      promptVersion: "v1",
      events: [
        {
          type: "propuesta",
          occurredAt: new Date("2025-03-10T08:00:00Z"),
          messageIds: [messageId],
          observation: "Se propone una recogida.",
          confidence: 0.9,
          analyses: [{ dimension: "cooperación", score: 0.8 }],
          target: { kind: "new", title: "recogida del sábado", category: "planes" },
        },
      ],
    });

    const [savedCase] = await testDb.select().from(cases);
    expect(savedCase?.title).toBe("recogida del sábado");
    expect(savedCase?.status).toBe("open");

    const [savedEvent] = await testDb.select().from(events);
    expect(savedEvent?.caseId).toBe(savedCase?.id);

    // SI-014: el Event tiene su evidencia en event_messages.
    const evidencia = await testDb
      .select()
      .from(eventMessages)
      .where(eq(eventMessages.eventId, savedEvent!.id));
    expect(evidencia.map((e) => e.messageId)).toEqual([messageId]);

    const [savedAnalysis] = await testDb.select().from(analyses);
    expect(savedAnalysis?.subjectId).toBe(savedEvent?.id);
    expect(savedAnalysis?.dimension).toBe("cooperación");
    // numeric(3,2) redondea a dos decimales; se guarda como string.
    expect(Number(savedAnalysis?.score)).toBeCloseTo(0.8);
    expect(savedAnalysis?.model).toBe("modelo-de-prueba");

    const [savedObservation] = await testDb.select().from(observations);
    expect(savedObservation?.statement).toBe("Se propone una recogida.");

    const [state] = await testDb
      .select()
      .from(messageProcessingState)
      .where(eq(messageProcessingState.messageId, messageId));
    expect(state?.status).toBe("CASE_READY");
  });

  it("asocia el Event a un Case existente sin crear uno nuevo", async () => {
    const { conversationId, participantId } = await seedConversation();
    const messageId = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z")
    );
    const [existente] = await testDb
      .insert(cases)
      .values({ conversationId, title: "reuniones de marzo", category: "planes" })
      .returning({ id: cases.id });

    await repo.recordEventDetection({
      conversationId,
      processedMessageIds: [messageId],
      model: "m",
      promptVersion: "v1",
      events: [
        {
          type: "aceptación",
          occurredAt: new Date("2025-03-10T08:00:00Z"),
          messageIds: [messageId],
          observation: "Acepta.",
          confidence: 0.7,
          analyses: [],
          target: { kind: "existing", caseId: existente!.id },
        },
      ],
    });

    expect(await testDb.select().from(cases)).toHaveLength(1);
    const [savedEvent] = await testDb.select().from(events);
    expect(savedEvent?.caseId).toBe(existente!.id);
  });

  it("rechaza un Event sin mensajes de respaldo y no deja nada a medias (SI-014)", async () => {
    const { conversationId, participantId } = await seedConversation();
    const messageId = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z")
    );

    await expect(
      repo.recordEventDetection({
        conversationId,
        processedMessageIds: [messageId],
        model: "m",
        promptVersion: "v1",
        events: [
          {
            type: "propuesta",
            occurredAt: new Date("2025-03-10T08:00:00Z"),
            messageIds: [],
            observation: "sin evidencia",
            confidence: 0.5,
            analyses: [],
            target: { kind: "new", title: "algo", category: "otro" },
          },
        ],
      })
    ).rejects.toThrow(/SI-014/);

    // La transacción revierte: ni Case suelto, ni estado avanzado.
    expect(await testDb.select().from(cases)).toHaveLength(0);
    const [state] = await testDb
      .select()
      .from(messageProcessingState)
      .where(eq(messageProcessingState.messageId, messageId));
    expect(state?.status).toBe("ENTITY_READY");
  });

  it("findOpenCases reporta la fecha del Event más reciente de cada Case", async () => {
    const { conversationId, participantId } = await seedConversation();
    const messageId = await seedMessage(
      conversationId,
      participantId,
      new Date("2025-03-10T08:00:00Z")
    );
    const [conActividad] = await testDb
      .insert(cases)
      .values({ conversationId, title: "con eventos", category: "planes" })
      .returning({ id: cases.id });
    await testDb
      .insert(cases)
      .values({ conversationId, title: "sin eventos", category: "salud" });

    for (const fecha of ["2025-03-01T00:00:00Z", "2025-04-01T00:00:00Z"]) {
      const [ev] = await testDb
        .insert(events)
        .values({ caseId: conActividad!.id, type: "propuesta", occurredAt: new Date(fecha) })
        .returning({ id: events.id });
      await testDb.insert(eventMessages).values({ eventId: ev!.id, messageId });
    }

    const open = await repo.findOpenCases(conversationId);

    const activo = open.find((c) => c.title === "con eventos");
    const vacio = open.find((c) => c.title === "sin eventos");
    expect(activo?.lastEventAt).toEqual(new Date("2025-04-01T00:00:00Z"));
    // Un Case sin eventos no tiene proximidad temporal que medir.
    expect(vacio?.lastEventAt).toBeNull();
  });

  it("no devuelve Cases cerrados", async () => {
    const { conversationId } = await seedConversation();
    await testDb
      .insert(cases)
      .values({ conversationId, title: "cerrado", category: "otro", status: "closed" });

    expect(await repo.findOpenCases(conversationId)).toEqual([]);
  });
});
