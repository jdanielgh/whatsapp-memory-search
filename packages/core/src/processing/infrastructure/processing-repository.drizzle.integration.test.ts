// Integration test obligatorio (rules/dev-style.md, regla 4, ampliada a
// cualquier código que interactúe con Postgres real): un WHERE mal
// armado acá (leftJoin + isNull/or) dejaría mensajes reprocesándose
// indefinidamente o nunca marcándose METADATA_READY — un fake en memoria
// no puede detectar ese tipo de error de SQL. Corre contra la base de
// datos de test efímera (nunca la de desarrollo). Fixtures inventados
// (rules/agents-and-context.md).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import {
  conversations,
  messageEntities,
  messageMetadata,
  messageProcessingState,
  messages,
  participants,
} from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { DrizzleProcessingRepository } from "./processing-repository.drizzle.js";

async function seedMessage(overrides: {
  conversationId: string;
  participantId: string;
  content: string;
  kind?: string;
}) {
  const [row] = await testDb
    .insert(messages)
    .values({
      conversationId: overrides.conversationId,
      participantId: overrides.participantId,
      sentAt: new Date("2024-01-01T10:00:00.000Z"),
      content: overrides.content,
      kind: overrides.kind ?? "text",
      rawSource: overrides.content,
      status: "PERSISTED",
      contentHash: randomUUID(),
    })
    .returning({ id: messages.id });
  return row!.id;
}

describe("DrizzleProcessingRepository (integration)", () => {
  const repo = new DrizzleProcessingRepository(testDb);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("findMessagesPendingMetadataExtraction devuelve mensajes sin fila en message_processing_state", async () => {
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
    });

    const pending = await repo.findMessagesPendingMetadataExtraction(
      conversation!.id,
      100
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(messageId);
  });

  it("recordMetadataExtraction persiste message_metadata y avanza message_processing_state; deja de aparecer como pendiente", async () => {
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
      content: "hola con emoji 😀",
    });

    await repo.recordMetadataExtraction(messageId, {
      language: "es",
      emojis: ["😀"],
      emojiCount: 1,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    });

    const pendingAfter = await repo.findMessagesPendingMetadataExtraction(
      conversation!.id,
      100
    );
    expect(pendingAfter).toHaveLength(0);
  });

  it("recordMetadataExtraction es idempotente (upsert, no duplica filas al reejecutar)", async () => {
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
    });

    const metadata = {
      language: "es" as const,
      emojis: [],
      emojiCount: 0,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    };
    await repo.recordMetadataExtraction(messageId, metadata);
    // Reejecutar con un valor distinto — debe actualizar in place, no fallar por PK duplicada.
    await repo.recordMetadataExtraction(messageId, { ...metadata, language: "fr" });

    const rows = await testDb
      .select({ language: messageMetadata.language })
      .from(messageMetadata)
      .where(sql`${messageMetadata.messageId} = ${messageId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.language).toBe("fr");
  });

  it("listParticipants devuelve solo los participantes de la conversación indicada", async () => {
    const [conversationA] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [conversationB] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    await testDb
      .insert(participants)
      .values({ conversationId: conversationA!.id, displayName: "Ana", role: "desconocido" });
    await testDb
      .insert(participants)
      .values({ conversationId: conversationB!.id, displayName: "Beto", role: "desconocido" });

    const result = await repo.listParticipants(conversationA!.id);

    expect(result).toHaveLength(1);
    expect(result[0]!.displayName).toBe("Ana");
  });

  it("findMessagesPendingEntityDetection solo devuelve mensajes en estado METADATA_READY", async () => {
    const [conversation] = await testDb
      .insert(conversations)
      .values({ title: null })
      .returning({ id: conversations.id });
    const [participant] = await testDb
      .insert(participants)
      .values({ conversationId: conversation!.id, displayName: "Ana", role: "desconocido" })
      .returning({ id: participants.id });

    const notYetMetadataId = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "todavia sin metadata",
    });
    const readyId = await seedMessage({
      conversationId: conversation!.id,
      participantId: participant!.id,
      content: "con metadata lista",
    });
    await repo.recordMetadataExtraction(readyId, {
      language: null,
      emojis: [],
      emojiCount: 0,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    });

    const pending = await repo.findMessagesPendingEntityDetection(conversation!.id, 100);

    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(readyId);
    expect(pending.map((m) => m.id)).not.toContain(notYetMetadataId);
  });

  it("recordEntityDetection persiste message_entities y avanza a ENTITY_READY; deja de aparecer como pendiente", async () => {
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
      content: "nos vemos en el teatro",
    });
    await repo.recordMetadataExtraction(messageId, {
      language: "es",
      emojis: [],
      emojiCount: 0,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    });

    await repo.recordEntityDetection(messageId, [
      { entityType: "lugar", value: "el teatro", normalizedValue: null },
    ]);

    const entityRows = await testDb
      .select({ value: messageEntities.value, entityType: messageEntities.entityType })
      .from(messageEntities)
      .where(sql`${messageEntities.messageId} = ${messageId}`);
    expect(entityRows).toEqual([{ value: "el teatro", entityType: "lugar" }]);

    const [stateRow] = await testDb
      .select({ status: messageProcessingState.status })
      .from(messageProcessingState)
      .where(sql`${messageProcessingState.messageId} = ${messageId}`);
    expect(stateRow?.status).toBe("ENTITY_READY");

    const pendingAfter = await repo.findMessagesPendingEntityDetection(conversation!.id, 100);
    expect(pendingAfter).toHaveLength(0);
  });

  it("recordEntityDetection reemplaza (delete+reinsert) las entidades al reejecutar, no las acumula", async () => {
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
    });

    await repo.recordEntityDetection(messageId, [
      { entityType: "persona", value: "Juan", normalizedValue: null },
    ]);
    await repo.recordEntityDetection(messageId, [
      { entityType: "lugar", value: "el parque", normalizedValue: null },
    ]);

    const entityRows = await testDb
      .select({ value: messageEntities.value })
      .from(messageEntities)
      .where(sql`${messageEntities.messageId} = ${messageId}`);
    expect(entityRows).toEqual([{ value: "el parque" }]);
  });
});
