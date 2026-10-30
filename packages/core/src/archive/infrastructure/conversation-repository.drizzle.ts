// Implementación Postgres/Drizzle de ConversationRepository
// (src/archive/repositories/conversation-repository.ts). Única pieza que
// sabe de SQL para el Aggregate Conversation — el caso de uso
// (ImportConversation/SyncNewMessages) no importa Drizzle directamente.

import { and, count, eq, inArray } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  attachments,
  conversations,
  messages,
  participants,
} from "../../infrastructure/db/schema.js";
import type {
  ConversationRepository,
  InsertedMessage,
  NewMessageInput,
} from "../repositories/conversation-repository.js";

// Tamaño de lote para paralelizar inserts independientes (dedup es por
// content_hash, no por orden — ver insertMessages). Acotado para no
// agotar el pool de conexiones de node-postgres (default: 10).
const INSERT_CONCURRENCY = 10;

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async findConversation(): Promise<{ id: string } | null> {
    const [existing] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .limit(1);
    return existing ?? null;
  }

  async getOrCreateConversation(title: string | null): Promise<{ id: string }> {
    const existing = await this.findConversation();
    if (existing) return existing;
    const [created] = await this.db
      .insert(conversations)
      .values({ title })
      .returning({ id: conversations.id });
    return created!;
  }

  async getOrCreateParticipant(
    conversationId: string,
    displayName: string,
    role: string
  ): Promise<{ id: string }> {
    const [existing] = await this.db
      .select({ id: participants.id })
      .from(participants)
      .where(
        and(
          eq(participants.conversationId, conversationId),
          eq(participants.displayName, displayName)
        )
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(participants)
      .values({ conversationId, displayName, role })
      .returning({ id: participants.id });
    return created!;
  }

  async countMessages(conversationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    return row?.value ?? 0;
  }

  async filterNewContentHashes(
    conversationId: string,
    hashes: string[]
  ): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();

    const existingRows = await this.db
      .select({ contentHash: messages.contentHash })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          inArray(messages.contentHash, hashes)
        )
      );
    const existingHashes = new Set(existingRows.map((r) => r.contentHash));
    return new Set(hashes.filter((h) => !existingHashes.has(h)));
  }

  private async insertOneMessage(
    conversationId: string,
    m: NewMessageInput
  ): Promise<InsertedMessage> {
    // Una transacción por mensaje (no una sola para todo el lote): si
    // una corrida falla a mitad de archivo, lo ya insertado sobrevive
    // (docs/ERROR_HANDLING.md, "Recuperación por lote").
    return this.db.transaction(async (tx) => {
      const [msgRow] = await tx
        .insert(messages)
        .values({
          conversationId,
          participantId: m.participantId,
          sentAt: m.sentAt,
          content: m.content,
          kind: m.kind,
          deletedBySender: m.deletedBySender,
          rawSource: m.rawSource,
          status: m.status,
          contentHash: m.contentHash,
        })
        .returning({ id: messages.id, contentHash: messages.contentHash });

      if (m.attachment) {
        await tx.insert(attachments).values({
          messageId: msgRow!.id,
          type: m.attachment.type,
          status: m.attachment.status,
        });
      }

      return msgRow!;
    });
  }

  async insertMessages(
    conversationId: string,
    toInsert: NewMessageInput[]
  ): Promise<InsertedMessage[]> {
    const inserted: InsertedMessage[] = [];
    // Lotes de INSERT_CONCURRENCY en paralelo (independientes entre sí -
    // dedup es por content_hash, no por orden de inserción). Se espera a
    // que todo el lote asiente (allSettled) antes de propagar un fallo,
    // para no dejar transacciones del mismo lote sin resolver ni perder
    // del conteo lo que sí se insertó (docs/ERROR_HANDLING.md,
    // "Recuperación por lote").
    for (let i = 0; i < toInsert.length; i += INSERT_CONCURRENCY) {
      const chunk = toInsert.slice(i, i + INSERT_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((m) => this.insertOneMessage(conversationId, m))
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          inserted.push(result.value);
        }
      }
      const failure = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (failure) {
        throw failure.reason;
      }
    }
    return inserted;
  }
}
