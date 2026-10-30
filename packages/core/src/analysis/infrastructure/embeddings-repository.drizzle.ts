// Implementación Postgres/Drizzle de EmbeddingsRepository
// (src/analysis/repositories/embeddings-repository.ts).

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import { embeddings, messageProcessingState, messages } from "../../infrastructure/db/schema.js";
import { findPrecedingMessages as findPrecedingMessagesQuery } from "../../infrastructure/db/preceding-messages.js";
import type {
  EmbeddingsRepository,
  MessageForEmbedding,
  RecordEmbeddingInput,
} from "../repositories/embeddings-repository.js";

const SELECTED = {
  id: messages.id,
  content: messages.content,
  kind: messages.kind,
  participantId: messages.participantId,
  sentAt: messages.sentAt,
};

// Ver embeddings-repository.ts: no se exige llegar a SUMMARY_READY
// (fase 07 todavía no existe en código) — cualquier estado a partir de
// CASE_READY es candidato a embedding.
const PENDING_STATUSES = ["CASE_READY", "INSIGHT_READY", "SUMMARY_READY"] as const;

export class DrizzleEmbeddingsRepository implements EmbeddingsRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async findMessagesPendingEmbedding(
    conversationId: string,
    limit: number
  ): Promise<MessageForEmbedding[]> {
    return this.db
      .select(SELECTED)
      .from(messages)
      .innerJoin(messageProcessingState, eq(messageProcessingState.messageId, messages.id))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          inArray(messageProcessingState.status, [...PENDING_STATUSES])
        )
      )
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(limit);
  }

  async findPrecedingMessages(input: {
    conversationId: string;
    beforeSentAt: Date;
    beforeId: string;
    count: number;
  }): Promise<MessageForEmbedding[]> {
    // SQL real vive en infrastructure/db/preceding-messages.ts — misma
    // fuente que usa Semantic Search para reconstruir la ventana en
    // tiempo de consulta (docs/DECISIONS.md, "Pendiente para fase 06").
    return findPrecedingMessagesQuery(input, this.db);
  }

  async recordEmbedding(input: RecordEmbeddingInput): Promise<void> {
    // Una transacción por mensaje: si un lote falla a mitad de camino, lo
    // ya marcado EMBEDDED sobrevive y una reejecución continúa solo con
    // lo que falta (docs/ERROR_HANDLING.md, "Recuperación por lote").
    await this.db.transaction(async (tx) => {
      await tx.insert(embeddings).values({
        subjectType: "Message",
        subjectId: input.messageId,
        model: input.model,
        dims: input.dims,
        vector: input.vector,
        generatedAt: new Date(),
      });

      await tx
        .insert(messageProcessingState)
        .values({ messageId: input.messageId, status: "EMBEDDED" })
        .onConflictDoUpdate({
          target: messageProcessingState.messageId,
          set: { status: "EMBEDDED", updatedAt: new Date() },
        });
    });
  }

  async markEmbeddedWithoutVector(messageId: string): Promise<void> {
    await this.db
      .insert(messageProcessingState)
      .values({ messageId, status: "EMBEDDED" })
      .onConflictDoUpdate({
        target: messageProcessingState.messageId,
        set: { status: "EMBEDDED", updatedAt: new Date() },
      });
  }
}
