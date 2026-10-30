// Integration test obligatorio (rules/dev-style.md, regla 4): este
// repositorio escribe evidencia inmutable — un fallo silencioso acá
// (un WHERE mal armado, una transacción que no aísla bien) es pérdida
// de datos real, el mismo criterio que ya aplica a whatsapp-ingest.
// Corre contra la base de datos de test efímera (nunca la de
// desarrollo), ver src/infrastructure/db/test-db.ts. Todos los fixtures
// son texto inventado (rules/agents-and-context.md).

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import { messages } from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { DrizzleConversationRepository } from "./conversation-repository.drizzle.js";

describe("DrizzleConversationRepository (integration)", () => {
  const repo = new DrizzleConversationRepository(testDb);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("getOrCreateConversation crea una sola vez y reutiliza en llamadas siguientes", async () => {
    const first = await repo.getOrCreateConversation("Conversación de prueba");
    const second = await repo.getOrCreateConversation("Otro título, se ignora");

    expect(second.id).toBe(first.id);
    expect(await repo.findConversation()).toEqual(first);
  });

  it("findConversation devuelve null si todavía no existe ninguna", async () => {
    expect(await repo.findConversation()).toBeNull();
  });

  it("getOrCreateParticipant dedupea por displayName dentro de la conversación", async () => {
    const conversation = await repo.getOrCreateConversation(null);

    const first = await repo.getOrCreateParticipant(conversation.id, "Ana", "desconocido");
    const second = await repo.getOrCreateParticipant(conversation.id, "Ana", "desconocido");
    const other = await repo.getOrCreateParticipant(conversation.id, "Beto", "desconocido");

    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });

  it("filterNewContentHashes excluye los hashes ya persistidos", async () => {
    const conversation = await repo.getOrCreateConversation(null);
    const participant = await repo.getOrCreateParticipant(conversation.id, "Ana", "desconocido");

    await repo.insertMessages(conversation.id, [
      {
        participantId: participant.id,
        sentAt: new Date("2024-01-01T10:00:00.000Z"),
        content: "hola",
        kind: "text",
        deletedBySender: false,
        rawSource: "[01/01/24, 10:00:00 a.m.] Ana: hola",
        status: "PERSISTED",
        contentHash: "hash-existente",
        attachment: null,
      },
    ]);

    const result = await repo.filterNewContentHashes(conversation.id, [
      "hash-existente",
      "hash-nuevo",
    ]);

    expect(result).toEqual(new Set(["hash-nuevo"]));
  });

  it("insertMessages persiste el mensaje y su adjunto atómicamente, y countMessages lo refleja", async () => {
    const conversation = await repo.getOrCreateConversation(null);
    const participant = await repo.getOrCreateParticipant(conversation.id, "Ana", "desconocido");

    const [inserted] = await repo.insertMessages(conversation.id, [
      {
        participantId: participant.id,
        sentAt: new Date("2024-01-01T10:00:00.000Z"),
        content: "‎imagen omitida",
        kind: "text",
        deletedBySender: false,
        rawSource: "[01/01/24, 10:00:00 a.m.] Ana: ‎imagen omitida",
        status: "PERSISTED",
        contentHash: "hash-con-adjunto",
        attachment: { type: "imagen", status: "unavailable" },
      },
    ]);

    expect(inserted).toBeDefined();
    expect(await repo.countMessages(conversation.id)).toBe(1);

    const [persisted] = await testDb
      .select({ contentHash: messages.contentHash })
      .from(messages)
      .where(eq(messages.id, inserted!.id));
    expect(persisted?.contentHash).toBe("hash-con-adjunto");
  });

  it("no permite DELETE sobre mensajes con el rol de aplicación (cma_app)", async () => {
    const conversation = await repo.getOrCreateConversation(null);
    const participant = await repo.getOrCreateParticipant(conversation.id, "Ana", "desconocido");
    await repo.insertMessages(conversation.id, [
      {
        participantId: participant.id,
        sentAt: new Date(),
        content: "hola",
        kind: "text",
        deletedBySender: false,
        rawSource: "raw",
        status: "PERSISTED",
        contentHash: "hash-inmutable",
        attachment: null,
      },
    ]);

    await expect(
      testDb.execute(sql`DELETE FROM messages WHERE content_hash = 'hash-inmutable'`)
    ).rejects.toThrow(/permission denied/i);
  });
});
