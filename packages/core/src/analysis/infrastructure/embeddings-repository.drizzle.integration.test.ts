// Integration test obligatorio (rules/dev-style.md regla 4, ampliada a
// cualquier código que interactúe con Postgres real): el filtro por
// message_processing_state.status y la resolución de "mensajes previos"
// son SQL real que un fake en memoria no puede validar (orden por
// sent_at/id, comparación de rango). Corre contra la base de datos de
// test efímera (nunca la de desarrollo). Fixtures inventados
// (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import {
  conversations,
  embeddings,
  messageProcessingState,
  messages,
  participants,
} from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { DrizzleEmbeddingsRepository } from "./embeddings-repository.drizzle.js";

async function seedMessage(overrides: {
  conversationId: string;
  participantId: string;
  content: string;
  sentAt: string;
  kind?: string;
}) {
  const [row] = await testDb
    .insert(messages)
    .values({
      conversationId: overrides.conversationId,
      participantId: overrides.participantId,
      sentAt: new Date(overrides.sentAt),
      content: overrides.content,
      kind: overrides.kind ?? "text",
      rawSource: overrides.content,
      status: "PERSISTED",
      contentHash: randomUUID(),
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function setStatus(messageId: string, status: string) {
  await testDb
    .insert(messageProcessingState)
    .values({ messageId, status })
    .onConflictDoUpdate({
      target: messageProcessingState.messageId,
      set: { status, updatedAt: new Date() },
    });
}

describe("DrizzleEmbeddingsRepository (integration)", () => {
  const repo = new DrizzleEmbeddingsRepository(testDb);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("findMessagesPendingEmbedding solo devuelve mensajes en CASE_READY/INSIGHT_READY/SUMMARY_READY, en orden cronológico", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });

    const notReady = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "sin procesar",
      sentAt: "2025-03-01T10:00:00Z",
    });
    const second = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "segundo",
      sentAt: "2025-03-01T12:00:00Z",
    });
    const first = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "primero",
      sentAt: "2025-03-01T11:00:00Z",
    });
    const alreadyEmbedded = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "ya embebido",
      sentAt: "2025-03-01T09:00:00Z",
    });

    await setStatus(second, "CASE_READY");
    await setStatus(first, "INSIGHT_READY");
    await setStatus(alreadyEmbedded, "EMBEDDED");
    // notReady se queda sin fila en message_processing_state (implícito 'PERSISTED').

    const pending = await repo.findMessagesPendingEmbedding(conversation!.id, 100);

    expect(pending.map((m) => m.id)).toEqual([first, second]);
    expect(pending.map((m) => m.id)).not.toContain(notReady);
    expect(pending.map((m) => m.id)).not.toContain(alreadyEmbedded);
  });

  it("findPrecedingMessages devuelve los N inmediatos anteriores, en orden cronológico ascendente", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });

    const m1 = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "uno",
      sentAt: "2025-03-01T10:00:00Z",
    });
    const m2 = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "dos",
      sentAt: "2025-03-01T10:01:00Z",
    });
    const m3 = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "tres",
      sentAt: "2025-03-01T10:02:00Z",
    });
    const anchor = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "ancla",
      sentAt: "2025-03-01T10:03:00Z",
    });

    const [anchorRow] = await testDb
      .select({ sentAt: messages.sentAt })
      .from(messages)
      .where(sql`${messages.id} = ${anchor}`);

    const preceding = await repo.findPrecedingMessages({
      conversationId: conversation!.id,
      beforeSentAt: anchorRow!.sentAt,
      beforeId: anchor,
      count: 2,
    });

    // Los 2 inmediatos anteriores (m2, m3), en orden cronológico — no m1.
    expect(preceding.map((m) => m.id)).toEqual([m2, m3]);
  });

  it("no cruza mensajes de otra Conversation al buscar contexto previo", async () => {
    const [convA] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [convB] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participantA] = await testDb
      .insert(participants)
      .values({ conversationId: convA!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });
    const [participantB] = await testDb
      .insert(participants)
      .values({ conversationId: convB!.id, displayName: "Beto", role: "desconocido" })
      .returning({ id: participants.id });

    await seedMessage({
      conversationId: convB!.id,
      participantId: participantB!.id,
      content: "de otra conversación",
      sentAt: "2025-03-01T09:00:00Z",
    });
    const anchor = await seedMessage({
      conversationId: convA!.id,
      participantId: participantA!.id,
      content: "ancla",
      sentAt: "2025-03-01T10:00:00Z",
    });

    const preceding = await repo.findPrecedingMessages({
      conversationId: convA!.id,
      beforeSentAt: new Date("2025-03-01T10:00:00Z"),
      beforeId: anchor,
      count: 5,
    });

    expect(preceding).toEqual([]);
  });

  it("recordEmbedding persiste la fila y avanza a EMBEDDED; deja de aparecer como pendiente", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });
    const messageId = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "hola",
      sentAt: "2025-03-01T10:00:00Z",
    });
    await setStatus(messageId, "CASE_READY");

    const vector = Array.from({ length: 1024 }, () => 0.001);
    await repo.recordEmbedding({ messageId, model: "voyage-3-large", dims: 1024, vector });

    const rows = await testDb
      .select({ subjectId: embeddings.subjectId, subjectType: embeddings.subjectType, model: embeddings.model, dims: embeddings.dims })
      .from(embeddings)
      .where(sql`${embeddings.subjectId} = ${messageId}`);
    expect(rows).toEqual([
      { subjectId: messageId, subjectType: "Message", model: "voyage-3-large", dims: 1024 },
    ]);

    const [stateRow] = await testDb
      .select({ status: messageProcessingState.status })
      .from(messageProcessingState)
      .where(sql`${messageProcessingState.messageId} = ${messageId}`);
    expect(stateRow?.status).toBe("EMBEDDED");

    const pendingAfter = await repo.findMessagesPendingEmbedding(conversation!.id, 100);
    expect(pendingAfter).toHaveLength(0);
  });

  it("recordEmbedding nunca hace UPDATE de una fila existente: dos generaciones conviven como filas distintas (SI-028)", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });
    const messageId = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "hola",
      sentAt: "2025-03-01T10:00:00Z",
    });
    await setStatus(messageId, "CASE_READY");

    const vectorA = Array.from({ length: 1024 }, () => 0.001);
    await repo.recordEmbedding({ messageId, model: "voyage-3-large", dims: 1024, vector: vectorA });
    // "Regenerar" con otro modelo (misma dimensión, sin migración): se
    // inserta OTRA fila, no se pisa la anterior.
    const vectorB = Array.from({ length: 1024 }, () => 0.002);
    await repo.recordEmbedding({ messageId, model: "voyage-3.5-large", dims: 1024, vector: vectorB });

    const rows = await testDb
      .select({ model: embeddings.model })
      .from(embeddings)
      .where(sql`${embeddings.subjectId} = ${messageId}`);
    expect(rows.map((r) => r.model).sort()).toEqual(["voyage-3-large", "voyage-3.5-large"]);
  });

  it("markEmbeddedWithoutVector avanza el estado sin insertar fila en embeddings", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });
    const messageId = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "Llamada perdida",
      sentAt: "2025-03-01T10:00:00Z",
      kind: "call",
    });
    await setStatus(messageId, "CASE_READY");

    await repo.markEmbeddedWithoutVector(messageId);

    const rows = await testDb
      .select({ subjectId: embeddings.subjectId })
      .from(embeddings)
      .where(sql`${embeddings.subjectId} = ${messageId}`);
    expect(rows).toEqual([]);

    const [stateRow] = await testDb
      .select({ status: messageProcessingState.status })
      .from(messageProcessingState)
      .where(sql`${messageProcessingState.messageId} = ${messageId}`);
    expect(stateRow?.status).toBe("EMBEDDED");
  });
});
