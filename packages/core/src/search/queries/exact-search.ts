// Exact Search — Q-EX-01 a Q-EX-04 de docs/QUERY_CATALOG.md.
// Cierra UC-003 (consultar un mensaje) y UC-004 (buscar mensajes).
//
// SI-036: el resultado de la búsqueda semántica nunca sustituye a estas.
// Si el usuario pide algo literal ("el mensaje del 12 de marzo"), la
// respuesta sale de acá aunque la semántica también pudiera contestar.

import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import { messages } from "../../infrastructure/db/schema.js";
import type { EvidenceMessage } from "./evidence-search.js";

/**
 * Tope por defecto de filas devueltas. Existe para que ninguna consulta
 * pueda arrastrar toda la conversación a memoria (ni al contexto del
 * agente) por un rango mal puesto.
 */
export const DEFAULT_SEARCH_LIMIT = 100;

/**
 * Resultado de una consulta acotada.
 *
 * `truncated` no es un adorno: sin él, un resultado de exactamente
 * `limit` elementos es indistinguible de uno recortado, y quien consuma
 * esto (UC-014) podría responder "cambiamos el horario 100 veces" cuando
 * fueron 250 — una respuesta falsa que además viene con evidencia
 * adjunta, o sea falsa y creíble a la vez. Contar SIEMPRE se hace con
 * Q-ST-01 o con una agregación en SQL, nunca con la longitud de esta
 * lista.
 */
export interface SearchPage<T> {
  items: T[];
  truncated: boolean;
}

const SELECTED = {
  id: messages.id,
  sentAt: messages.sentAt,
  participantId: messages.participantId,
  content: messages.content,
  kind: messages.kind,
};

/**
 * Pide una fila más que el tope para saber si había más, y la descarta
 * antes de devolver.
 */
async function paginate<T>(
  rows: Promise<T[]>,
  limit: number
): Promise<SearchPage<T>> {
  const fetched = await rows;
  return { items: fetched.slice(0, limit), truncated: fetched.length > limit };
}

/** Q-EX-01 — Mensajes de una fecha exacta (UC-003). El día se interpreta en UTC. */
export async function findMessagesByDate(
  input: { conversationId: string; date: Date; limit?: number },
  db: Database = defaultDb
): Promise<SearchPage<EvidenceMessage>> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const start = new Date(
    Date.UTC(
      input.date.getUTCFullYear(),
      input.date.getUTCMonth(),
      input.date.getUTCDate()
    )
  );
  const end = new Date(start.getTime() + 86_400_000);

  return paginate(
    db
      .select(SELECTED)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          gte(messages.sentAt, start),
          // Fin exclusivo: con `lte` sobre el final del día, un mensaje
          // exactamente a medianoche aparecería en dos fechas distintas.
          sql`${messages.sentAt} < ${end}`
        )
      )
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(limit + 1),
    limit
  );
}

/**
 * Q-EX-02 — Mensajes que contienen un texto (UC-004).
 *
 * Usa el índice `GIN (to_tsvector('spanish', content))`. La expresión
 * debe coincidir EXACTAMENTE con la del índice (ver migrate.ts) o
 * Postgres lo ignora y hace un scan secuencial.
 *
 * `plainto_tsquery` en vez de `to_tsquery` porque la entrada viene del
 * usuario: interpreta el texto como palabras sueltas y no falla ante
 * operadores (`&`, `|`, `!`, paréntesis) que el usuario escriba sin
 * intención de usarlos como sintaxis.
 */
export async function findMessagesByText(
  input: { conversationId: string; text: string; limit?: number },
  db: Database = defaultDb
): Promise<SearchPage<EvidenceMessage>> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const query = input.text.trim();
  // Una búsqueda vacía traería la conversación entera; devolver nada es
  // más honesto que devolver todo.
  if (query === "") return { items: [], truncated: false };

  return paginate(
    db
      .select(SELECTED)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          sql`to_tsvector('spanish', ${messages.content}) @@ plainto_tsquery('spanish', ${query})`
        )
      )
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(limit + 1),
    limit
  );
}

/** Q-EX-03 — Mensajes de un participante (UC-004, UC-022). */
export async function findMessagesByParticipant(
  input: { participantId: string; limit?: number; offset?: number },
  db: Database = defaultDb
): Promise<SearchPage<EvidenceMessage>> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  return paginate(
    db
      .select(SELECTED)
      .from(messages)
      .where(eq(messages.participantId, input.participantId))
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(limit + 1)
      .offset(input.offset ?? 0),
    limit
  );
}

/** Q-EX-04 — Mensajes en un rango de fechas (UC-004, UC-012). `to` es exclusivo. */
export async function findMessagesByDateRange(
  input: { conversationId: string; from: Date; to: Date; limit?: number },
  db: Database = defaultDb
): Promise<SearchPage<EvidenceMessage>> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  return paginate(
    db
      .select(SELECTED)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          gte(messages.sentAt, input.from),
          sql`${messages.sentAt} < ${input.to}`
        )
      )
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(limit + 1),
    limit
  );
}

/** Recupera un mensaje puntual por id — apoyo de UC-003 y de la validación de evidencia. */
export async function findMessageById(
  messageId: string,
  db: Database = defaultDb
): Promise<EvidenceMessage | null> {
  const [row] = await db
    .select(SELECTED)
    .from(messages)
    .where(eq(messages.id, messageId));
  return row ?? null;
}

/**
 * Cuenta los mensajes que coinciden con un texto, sin traerlos.
 *
 * Existe para que responder "¿cuántas veces...?" nunca dependa de la
 * longitud de una lista acotada: el conteo sale de la base, entero, y la
 * lista de `findMessagesByText` sirve solo como evidencia de muestra.
 */
export async function countMessagesByText(
  input: { conversationId: string; text: string },
  db: Database = defaultDb
): Promise<number> {
  const query = input.text.trim();
  if (query === "") return 0;

  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        sql`to_tsvector('spanish', ${messages.content}) @@ plainto_tsquery('spanish', ${query})`
      )
    );
  return row?.total ?? 0;
}
