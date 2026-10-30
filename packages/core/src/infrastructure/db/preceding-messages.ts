// Consulta compartida: los hasta `count` mensajes inmediatamente
// anteriores a (`beforeSentAt`, `beforeId`) dentro de la misma
// Conversation, en orden cronológico ASCENDENTE.
//
// Fuente única de "qué es el hilo previo a un mensaje" — la usan dos
// consumidores que deben coincidir exactamente:
//   1. Embedding Generation (Pipeline 10, src/analysis/embeddings.ts vía
//      EmbeddingsRepository.findPrecedingMessages) para decidir QUÉ SE
//      EMBEBE junto al mensaje ancla (src/analysis/domain/embedding-chunking.ts).
//   2. Semantic Search en tiempo de consulta
//      (src/search/queries/semantic-search.ts) para reconstruir la misma
//      ventana que se embebió y devolverla junto al resultado
//      (docs/DECISIONS.md, "Pendiente para fase 06: la ventana embebida
//      no viaja con el resultado").
//
// Antes vivía duplicada como SQL casi idéntico en ambos lugares — moverla
// acá (infraestructura, base de la que ya dependen `analysis` y `search`)
// evita que las dos ventanas puedan divergir por un cambio hecho en un
// solo sitio, sin introducir una dependencia nueva entre módulos de
// dominio.
//
// Evidencia ya persistida e inmutable (SI-002): el resultado de esta
// consulta para un mensaje dado nunca cambia.

import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import type { Database } from "./client.js";
import { db as defaultDb } from "./client.js";
import { messages } from "./schema.js";

export interface PrecedingMessage {
  id: string;
  content: string;
  kind: string;
  participantId: string;
  sentAt: Date;
}

const SELECTED = {
  id: messages.id,
  content: messages.content,
  kind: messages.kind,
  participantId: messages.participantId,
  sentAt: messages.sentAt,
};

export async function findPrecedingMessages(
  input: {
    conversationId: string;
    beforeSentAt: Date;
    beforeId: string;
    count: number;
  },
  db: Database = defaultDb
): Promise<PrecedingMessage[]> {
  if (input.count <= 0) return [];
  const rows = await db
    .select(SELECTED)
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        or(
          lt(messages.sentAt, input.beforeSentAt),
          and(eq(messages.sentAt, input.beforeSentAt), lt(messages.id, input.beforeId))
        )
      )
    )
    // Más reciente primero para poder limitar a los N inmediatos
    // anteriores; se revierte abajo a orden cronológico ascendente, que
    // es lo que esperan buildEmbeddingChunkText y quien reconstruye la
    // ventana en Semantic Search.
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(input.count);
  return rows.reverse();
}
