// Implementación Postgres/Drizzle de ProcessingRepository
// (src/processing/repositories/processing-repository.ts).

import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import {
  messageEntities,
  messageMetadata,
  messageProcessingState,
  messages,
  participants,
} from "../../infrastructure/db/schema.js";
import type { DetectedEntity } from "../domain/entity-detection.js";
import type { ExtractedMetadata } from "../domain/metadata-extraction.js";
import type {
  MessageForEntityDetection,
  MessageForMetadataExtraction,
  ParticipantForMetadataExtraction,
  ProcessingRepository,
} from "../repositories/processing-repository.js";

export class DrizzleProcessingRepository implements ProcessingRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async listParticipants(
    conversationId: string
  ): Promise<ParticipantForMetadataExtraction[]> {
    return this.db
      .select({ id: participants.id, displayName: participants.displayName })
      .from(participants)
      .where(eq(participants.conversationId, conversationId));
  }

  async findMessagesPendingMetadataExtraction(
    conversationId: string,
    limit: number
  ): Promise<MessageForMetadataExtraction[]> {
    const rows = await this.db
      .select({
        id: messages.id,
        content: messages.content,
        kind: messages.kind,
        participantId: messages.participantId,
      })
      .from(messages)
      .leftJoin(
        messageProcessingState,
        eq(messageProcessingState.messageId, messages.id)
      )
      .where(
        and(
          eq(messages.conversationId, conversationId),
          or(
            isNull(messageProcessingState.messageId),
            eq(messageProcessingState.status, "PERSISTED")
          )
        )
      )
      .limit(limit);
    return rows;
  }

  async recordMetadataExtraction(
    messageId: string,
    metadata: ExtractedMetadata
  ): Promise<void> {
    // Una transacción por mensaje: si un lote falla a mitad de camino, lo
    // ya marcado METADATA_READY sobrevive y una reejecución (PL-003)
    // continúa solo con lo que falta (docs/ERROR_HANDLING.md).
    await this.db.transaction(async (tx) => {
      await tx
        .insert(messageMetadata)
        .values({
          messageId,
          language: metadata.language,
          emojiCount: metadata.emojiCount,
          emojis: metadata.emojis,
          mentionedParticipantIds: metadata.mentionedParticipantIds,
          mentionedRawNames: metadata.mentionedRawNames,
        })
        .onConflictDoUpdate({
          target: messageMetadata.messageId,
          set: {
            language: metadata.language,
            emojiCount: metadata.emojiCount,
            emojis: metadata.emojis,
            mentionedParticipantIds: metadata.mentionedParticipantIds,
            mentionedRawNames: metadata.mentionedRawNames,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(messageProcessingState)
        .values({ messageId, status: "METADATA_READY" })
        .onConflictDoUpdate({
          target: messageProcessingState.messageId,
          set: { status: "METADATA_READY", updatedAt: new Date() },
        });
    });
  }

  async findMessagesPendingEntityDetection(
    conversationId: string,
    limit: number
  ): Promise<MessageForEntityDetection[]> {
    return this.db
      .select({
        id: messages.id,
        content: messages.content,
        kind: messages.kind,
      })
      .from(messages)
      .innerJoin(
        messageProcessingState,
        eq(messageProcessingState.messageId, messages.id)
      )
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messageProcessingState.status, "METADATA_READY")
        )
      )
      .limit(limit);
  }

  async recordEntityDetection(
    messageId: string,
    entities: DetectedEntity[]
  ): Promise<void> {
    // Una transacción por mensaje, mismo criterio de recuperación por
    // lote que recordMetadataExtraction (docs/ERROR_HANDLING.md).
    await this.db.transaction(async (tx) => {
      await tx
        .delete(messageEntities)
        .where(eq(messageEntities.messageId, messageId));

      if (entities.length > 0) {
        await tx.insert(messageEntities).values(
          entities.map((e) => ({
            messageId,
            entityType: e.entityType,
            value: e.value,
            normalizedValue: e.normalizedValue,
          }))
        );
      }

      await tx
        .insert(messageProcessingState)
        .values({ messageId, status: "ENTITY_READY" })
        .onConflictDoUpdate({
          target: messageProcessingState.messageId,
          set: { status: "ENTITY_READY", updatedAt: new Date() },
        });
    });
  }
}
