// Integration tests del Search Layer (rules/dev-style.md regla 4): son
// consultas SQL puras, así que un fake en memoria no probaría nada — lo
// que puede fallar es el SQL mismo (el diccionario 'spanish' del índice
// de texto, los bordes de rango de fechas, los GROUP BY de los conteos).
//
// Corren contra la base de datos de test efímera, nunca la de desarrollo.
// Fixtures inventados (rules/agents-and-context.md): ninguno de estos
// textos proviene de la conversación real.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import {
  analyses,
  cases,
  conversations,
  eventMessages,
  events,
  insights,
  messages,
  observations,
  participants,
} from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import * as exact from "./exact-search.js";
import * as evidence from "./evidence-search.js";
import * as timeline from "./timeline-search.js";
import * as caseSearch from "./case-search.js";
import * as statistics from "./statistics.js";

// Todas las consultas del Search Layer reciben la conexión como último
// parámetro OPCIONAL, con la base de desarrollo por defecto. Olvidarlo en
// un test no falla: la consulta corre contra la base real y devuelve algo
// (vacío, o peor, datos verdaderos que hacen pasar el test por el motivo
// equivocado). Estos envoltorios dejan la conexión de test fijada una
// sola vez, en lugar de repetirla en cada una de las llamadas de abajo.
const findMessagesByDate: typeof exact.findMessagesByDate = (i) =>
  exact.findMessagesByDate(i, testDb);
const findMessagesByText: typeof exact.findMessagesByText = (i) =>
  exact.findMessagesByText(i, testDb);
const findMessagesByParticipant: typeof exact.findMessagesByParticipant = (i) =>
  exact.findMessagesByParticipant(i, testDb);
const findMessagesByDateRange: typeof exact.findMessagesByDateRange = (i) =>
  exact.findMessagesByDateRange(i, testDb);
const findMessageById: typeof exact.findMessageById = (i) =>
  exact.findMessageById(i, testDb);
const findEvidenceForEvent: typeof evidence.findEvidenceForEvent = (i) =>
  evidence.findEvidenceForEvent(i, testDb);
const findEvidenceForInsight: typeof evidence.findEvidenceForInsight = (i) =>
  evidence.findEvidenceForInsight(i, testDb);
const findEvidenceForAnalysis: typeof evidence.findEvidenceForAnalysis = (i) =>
  evidence.findEvidenceForAnalysis(i, testDb);
const findEventsInRange: typeof timeline.findEventsInRange = (i) =>
  timeline.findEventsInRange(i, testDb);
const findCaseTimeline: typeof timeline.findCaseTimeline = (i) =>
  timeline.findCaseTimeline(i, testDb);
const findParticipantActivity: typeof timeline.findParticipantActivity = (i) =>
  timeline.findParticipantActivity(i, testDb);
const findCaseDetail: typeof caseSearch.findCaseDetail = (i) =>
  caseSearch.findCaseDetail(i, testDb);
const findOpenCases: typeof caseSearch.findOpenCases = (i) =>
  caseSearch.findOpenCases(i, testDb);
const findCasesByCategory: typeof caseSearch.findCasesByCategory = (i) =>
  caseSearch.findCasesByCategory(i, testDb);
const getConversationStatistics: typeof statistics.getConversationStatistics = (i) =>
  statistics.getConversationStatistics(i, testDb);

interface Fixture {
  conversationId: string;
  ana: string;
  luis: string;
  caseId: string;
  eventId: string;
  messageIds: string[];
}

async function seed(): Promise<Fixture> {
  const [conversation] = await testDb
    .insert(conversations)
    .values({ title: "conversación de prueba" })
    .returning({ id: conversations.id });
  const conversationId = conversation!.id;

  const [ana] = await testDb
    .insert(participants)
    .values({ conversationId, displayName: "Ana", role: "desconocido" })
    .returning({ id: participants.id });
  const [luis] = await testDb
    .insert(participants)
    .values({ conversationId, displayName: "Luis", role: "desconocido" })
    .returning({ id: participants.id });

  const contenidos: Array<{ participantId: string; sentAt: string; content: string }> = [
    // "vacaciones" en plural: la búsqueda por "vacación" debe encontrarlo
    // gracias al stemming del diccionario 'spanish'.
    { participantId: ana!.id, sentAt: "2025-03-10T00:00:00Z", content: "propongo unas vacaciones en julio" },
    { participantId: luis!.id, sentAt: "2025-03-10T15:30:00Z", content: "me parece bien el plan" },
    { participantId: ana!.id, sentAt: "2025-03-11T09:00:00Z", content: "hablamos del teatro mañana" },
    { participantId: luis!.id, sentAt: "2025-04-20T12:00:00Z", content: "confirmo la cita médica" },
  ];

  const messageIds: string[] = [];
  for (const item of contenidos) {
    const [row] = await testDb
      .insert(messages)
      .values({
        conversationId,
        participantId: item.participantId,
        sentAt: new Date(item.sentAt),
        content: item.content,
        kind: "text",
        rawSource: item.content,
        status: "PERSISTED",
        contentHash: randomUUID(),
      })
      .returning({ id: messages.id });
    messageIds.push(row!.id);
  }

  const [caso] = await testDb
    .insert(cases)
    .values({ conversationId, title: "plan de vacaciones", category: "vacaciones" })
    .returning({ id: cases.id });
  const [evento] = await testDb
    .insert(events)
    .values({
      caseId: caso!.id,
      type: "propuesta",
      occurredAt: new Date("2025-03-10T00:00:00Z"),
    })
    .returning({ id: events.id });

  await testDb.insert(eventMessages).values([
    { eventId: evento!.id, messageId: messageIds[0]! },
    { eventId: evento!.id, messageId: messageIds[1]! },
  ]);
  await testDb.insert(observations).values({
    subjectType: "Event",
    subjectId: evento!.id,
    statement: "Se propone un plan de vacaciones para julio.",
    model: "modelo-de-prueba",
    generatedAt: new Date(),
  });

  return {
    conversationId,
    ana: ana!.id,
    luis: luis!.id,
    caseId: caso!.id,
    eventId: evento!.id,
    messageIds,
  };
}

describe("Search Layer (integration)", () => {
  let f: Fixture;

  beforeEach(async () => {
    await resetTestDatabase();
    f = await seed();
  });

  describe("Exact Search (Q-EX-*)", () => {
    it("Q-EX-01: devuelve los mensajes de una fecha exacta", async () => {
      const found = await findMessagesByDate({
        conversationId: f.conversationId,
        date: new Date("2025-03-10T00:00:00Z"),
      });
      expect(found.items.map((m) => m.id)).toEqual([f.messageIds[0], f.messageIds[1]]);
    });

    it("Q-EX-01: un mensaje a medianoche cuenta en un solo día", async () => {
      // Con un fin de rango inclusivo, el mensaje de las 00:00 del día 10
      // aparecería también como último mensaje del día 9.
      const dia9 = await findMessagesByDate({
        conversationId: f.conversationId,
        date: new Date("2025-03-09T00:00:00Z"),
      });
      expect(dia9.items).toEqual([]);
    });

    it("Q-EX-02: encuentra por texto usando el stemming del español", async () => {
      // El mensaje dice "vacaciones"; se busca en singular. Sin el
      // diccionario 'spanish' del índice esto no matchearía.
      const found = await findMessagesByText({
        conversationId: f.conversationId,
        text: "vacación",
      });
      expect(found.items.map((m) => m.id)).toEqual([f.messageIds[0]]);
    });

    it("Q-EX-02: no falla con caracteres que serían operadores de tsquery", async () => {
      // plainto_tsquery trata la entrada como palabras sueltas; con
      // to_tsquery esto lanzaría un error de sintaxis.
      const found = await findMessagesByText({
        conversationId: f.conversationId,
        text: "teatro & | !( ",
      });
      expect(found.items.map((m) => m.id)).toEqual([f.messageIds[2]]);
    });

    it("Q-EX-02: una búsqueda vacía no devuelve la conversación entera", async () => {
      const found = await findMessagesByText({
        conversationId: f.conversationId,
        text: "   ",
      });
      expect(found.items).toEqual([]);
    });

    it("Q-EX-03: devuelve los mensajes de un participante", async () => {
      const found = await findMessagesByParticipant({ participantId: f.ana });
      expect(found.items.map((m) => m.id)).toEqual([f.messageIds[0], f.messageIds[2]]);
    });

    it("Q-EX-04: filtra por rango con fin exclusivo", async () => {
      const found = await findMessagesByDateRange({
        conversationId: f.conversationId,
        from: new Date("2025-03-10T00:00:00Z"),
        to: new Date("2025-03-11T09:00:00Z"),
      });
      // El mensaje justo en `to` queda fuera.
      expect(found.items.map((m) => m.id)).toEqual([f.messageIds[0], f.messageIds[1]]);
    });

    it("avisa cuando el resultado viene recortado por el tope", async () => {
      // Sin esta señal, 2 de 4 resultados es indistinguible de 2 de 2, y
      // quien conteste "¿cuántas veces...?" contando la lista daría un
      // número falso con evidencia adjunta.
      const page = await findMessagesByDateRange({
        conversationId: f.conversationId,
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2030-01-01T00:00:00Z"),
        limit: 2,
      });
      expect(page.items).toHaveLength(2);
      expect(page.truncated).toBe(true);
    });

    it("no marca como recortado un resultado que cabe entero", async () => {
      const page = await findMessagesByDateRange({
        conversationId: f.conversationId,
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2030-01-01T00:00:00Z"),
        limit: 10,
      });
      expect(page.items).toHaveLength(4);
      expect(page.truncated).toBe(false);
    });

    it("cuenta coincidencias en la base, no sobre la lista acotada", async () => {
      const total = await exact.countMessagesByText(
        { conversationId: f.conversationId, text: "vacación" },
        testDb
      );
      expect(total).toBe(1);
    });

    it("findMessageById devuelve null si no existe", async () => {
      expect(await findMessageById(randomUUID())).toBeNull();
    });
  });

  describe("Evidence Search (Q-EV-*)", () => {
    it("Q-EV-02: devuelve el Event junto con sus mensajes originales", async () => {
      const result = await findEvidenceForEvent(f.eventId);
      expect(result?.event.id).toBe(f.eventId);
      expect(result?.evidence.map((m) => m.id)).toEqual([f.messageIds[0], f.messageIds[1]]);
      expect(result?.observations[0]?.statement).toContain("vacaciones");
    });

    it("Q-EV-02: devuelve null en vez del Event solo cuando no hay evidencia", async () => {
      // SI-015/SI-024: la interpretación nunca se entrega sin respaldo.
      const [huerfano] = await testDb
        .insert(events)
        .values({ caseId: f.caseId, type: "acuerdo", occurredAt: new Date() })
        .returning({ id: events.id });

      expect(await findEvidenceForEvent(huerfano!.id)).toBeNull();
    });

    it("Q-EV-01: resuelve la evidencia de un Insight vía sus Events", async () => {
      const [insight] = await testDb
        .insert(insights)
        .values({
          caseId: f.caseId,
          statement: "Se coordinan las vacaciones con antelación.",
          confidence: "0.80",
          derivedFromEventIds: [f.eventId],
        })
        .returning({ id: insights.id });

      const result = await findEvidenceForInsight(insight!.id);
      expect(result?.insight.confidence).toBeCloseTo(0.8);
      expect(result?.evidence.map((m) => m.id)).toEqual([f.messageIds[0], f.messageIds[1]]);
    });

    it("Q-EV-01: devuelve null si el Insight no se apoya en ningún Event con evidencia", async () => {
      const [insight] = await testDb
        .insert(insights)
        .values({
          caseId: f.caseId,
          statement: "Afirmación sin respaldo.",
          confidence: "0.50",
          derivedFromEventIds: [],
        })
        .returning({ id: insights.id });

      expect(await findEvidenceForInsight(insight!.id)).toBeNull();
    });

    it("Q-EV-03: devuelve el Analysis de un Event con su evidencia, confianza y modelo", async () => {
      const [analysis] = await testDb
        .insert(analyses)
        .values({
          subjectType: "Event",
          subjectId: f.eventId,
          dimension: "cooperación",
          score: "0.75",
          confidence: "0.90",
          model: "modelo-de-prueba",
          promptVersion: "v1",
          generatedAt: new Date(),
        })
        .returning({ id: analyses.id });

      const result = await findEvidenceForAnalysis(analysis!.id);
      // SI-024/SI-025: sin confidence y model la interpretación no es juzgable.
      expect(result?.analysis.confidence).toBeCloseTo(0.9);
      expect(result?.analysis.model).toBe("modelo-de-prueba");
      expect(result?.evidence).toHaveLength(2);
    });

    it("Q-EV-03: resuelve un Analysis cuyo sujeto es un Message", async () => {
      const [analysis] = await testDb
        .insert(analyses)
        .values({
          subjectType: "Message",
          subjectId: f.messageIds[2]!,
          dimension: "formalidad",
          score: "0.40",
          confidence: "0.60",
          model: "m",
          promptVersion: "v1",
          generatedAt: new Date(),
        })
        .returning({ id: analyses.id });

      const result = await findEvidenceForAnalysis(analysis!.id);
      expect(result?.evidence.map((m) => m.id)).toEqual([f.messageIds[2]]);
    });
  });

  describe("Timeline Search (Q-TL-*)", () => {
    it("Q-TL-01: devuelve eventos del rango con su Case y sus ids de evidencia", async () => {
      const timeline = await findEventsInRange({
        conversationId: f.conversationId,
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2026-01-01T00:00:00Z"),
      });
      expect(timeline.items).toHaveLength(1);
      expect(timeline.items[0]?.caseTitle).toBe("plan de vacaciones");
      // Trazabilidad puesta de entrada (SI-037), sin tener que pedirla aparte.
      expect(timeline.items[0]?.messageIds).toHaveLength(2);
    });

    it("Q-TL-02: devuelve la cronología de un Case", async () => {
      const timeline = await findCaseTimeline({ caseId: f.caseId });
      expect(timeline.items.map((e) => e.id)).toEqual([f.eventId]);
    });

    it("Q-TL-03: cuenta la actividad de un participante sin traer sus mensajes", async () => {
      const activity = await findParticipantActivity({ participantId: f.ana });
      expect(activity.messagesSent).toBe(2);
      expect(activity.firstMessageAt).toEqual(new Date("2025-03-10T00:00:00Z"));
      expect(activity.events.items).toHaveLength(1);
    });
  });

  describe("Case Search (Q-CS-*)", () => {
    it("Q-CS-01: devuelve el paquete completo del Case", async () => {
      const detail = await findCaseDetail(f.caseId);
      expect(detail?.case.title).toBe("plan de vacaciones");
      expect(detail?.timeline.items).toHaveLength(1);
      expect(detail?.insights).toEqual([]);
    });

    it("Q-CS-01: devuelve null si el Case no existe", async () => {
      expect(await findCaseDetail(randomUUID())).toBeNull();
    });

    it("Q-CS-02: lista los Cases abiertos con su conteo de eventos", async () => {
      const abiertos = await findOpenCases(f.conversationId);
      expect(abiertos).toHaveLength(1);
      expect(abiertos[0]?.eventCount).toBe(1);
      expect(abiertos[0]?.lastEventAt).toEqual(new Date("2025-03-10T00:00:00Z"));
    });

    it("Q-CS-02: no incluye Cases cerrados", async () => {
      await testDb
        .insert(cases)
        .values({
          conversationId: f.conversationId,
          title: "cerrado",
          category: "otro",
          status: "closed",
        });
      expect(await findOpenCases(f.conversationId)).toHaveLength(1);
    });

    it("Q-CS-03: filtra por categoría", async () => {
      expect(await findCasesByCategory({ conversationId: f.conversationId, category: "vacaciones" }))
        .toHaveLength(1);
      expect(await findCasesByCategory({ conversationId: f.conversationId, category: "salud" }))
        .toHaveLength(0);
    });
  });

  describe("Statistics (Q-ST-01)", () => {
    it("resuelve todos los conteos y el reparto por participante", async () => {
      const stats = await getConversationStatistics(f.conversationId);
      expect(stats.messageCount).toBe(4);
      expect(stats.eventCount).toBe(1);
      expect(stats.openCaseCount).toBe(1);
      expect(stats.pendingReminderCount).toBe(0);
      expect(stats.firstMessageAt).toEqual(new Date("2025-03-10T00:00:00Z"));
      expect(stats.lastMessageAt).toEqual(new Date("2025-04-20T12:00:00Z"));
      expect(stats.messagesByParticipant).toEqual([
        { participantId: f.ana, displayName: "Ana", messageCount: 2 },
        { participantId: f.luis, displayName: "Luis", messageCount: 2 },
      ]);
    });

    it("incluye a un participante sin mensajes con conteo 0", async () => {
      await testDb
        .insert(participants)
        .values({
          conversationId: f.conversationId,
          displayName: "Sistema",
          role: "sistema",
        });

      const stats = await getConversationStatistics(f.conversationId);
      const sistema = stats.messagesByParticipant.find((p) => p.displayName === "Sistema");
      // Con innerJoin desaparecería del reparto en vez de mostrar 0.
      expect(sistema?.messageCount).toBe(0);
    });
  });
});
