// Etiquetas neutrales de hablante ESTABLES en toda una Conversation.
//
// Por qué existe: `embedding-chunking.ts` y `detect-events.ts` etiquetan
// "Participante 1/2" por orden de aparición DENTRO de cada ventana. Eso es
// correcto mientras la ventana sea la unidad completa que ve el modelo —
// es el caso de Event Detection, que manda una ventana por prompt.
//
// Deja de serlo en cuanto varias ventanas conviven en un mismo prompt, que
// es exactamente lo que habilita `windowContent` de Semantic Search para
// la fase 06: comprobado sobre el corpus real, en un solo conjunto de 5
// resultados "Participante 1" eran DOS personas distintas. Concatenar esas
// ventanas haría que el LLM atribuyera frases a quien no las dijo — sobre
// una conversación que podría usarse como evidencia
// (rules/security-privacy.md regla 7), eso no es un detalle de formato.
//
// El orden es por primer mensaje de cada participante en la Conversation:
// determinista, reproducible entre corridas, y no depende de qué ventanas
// devolvió una consulta puntual.
//
// Se mantienen NEUTRALES (nunca `displayName`) a propósito: es lo que evita
// mandar nombres de terceros reales a un servicio externo
// (rules/security-privacy.md). Quien necesite resolver la identidad real
// para mostrarla al usuario lo hace localmente contra `participants`, con
// el `participantId` que viaja en el resultado.

import { asc, eq, min } from "drizzle-orm";
import type { Database } from "./client.js";
import { db as defaultDb } from "./client.js";
import { messages } from "./schema.js";

export type SpeakerLabels = ReadonlyMap<string, string>;

/** Etiqueta de reserva para un `participantId` ausente del mapa (no debería ocurrir: todo Message tiene participante). */
export const UNKNOWN_SPEAKER_LABEL = "Participante ?";

export function labelFor(labels: SpeakerLabels, participantId: string): string {
  return labels.get(participantId) ?? UNKNOWN_SPEAKER_LABEL;
}

/**
 * `participantId` -> "Participante N", numerados por orden de primera
 * aparición en la Conversation. Una sola consulta agregada: la usa Semantic
 * Search una vez por búsqueda, no una vez por ventana.
 */
export async function buildConversationSpeakerLabels(
  conversationId: string,
  db: Database = defaultDb
): Promise<SpeakerLabels> {
  const rows = await db
    .select({
      participantId: messages.participantId,
      firstSentAt: min(messages.sentAt),
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .groupBy(messages.participantId)
    .orderBy(asc(min(messages.sentAt)), asc(messages.participantId));

  const labels = new Map<string, string>();
  for (const row of rows) {
    labels.set(row.participantId, `Participante ${labels.size + 1}`);
  }
  return labels;
}
