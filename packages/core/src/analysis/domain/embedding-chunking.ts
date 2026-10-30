// Pipeline 10 - Embedding Generation (docs/PIPELINES.md, UC-005).
// Estrategia de chunking fijada por rag-engineer — ver docs/DECISIONS.md,
// "Embeddings: proveedor, modelo, chunking, top-k y regeneración".
//
// Chunk = el mensaje ancla + hasta CONTEXT_WINDOW_SIZE mensajes previos
// del mismo hilo, concatenados. Mensajes de WhatsApp son cortísimos y
// ambiguos fuera de su hilo ("dale", "no puedo ese día") — embeberlos
// aislados perdería justo la señal que hace útil la búsqueda semántica.
//
// Se prefirió esto a un modelo contextualizado (voyage-context-3) porque
// los mensajes previos son evidencia YA PERSISTIDA e INMUTABLE (SI-002):
// el chunk de un mensaje es determinista para siempre, nunca cambia
// cuando llegan mensajes nuevos después. Un documento "contextualizado"
// sobre una conversación que crece sin límite necesitaría rechunkear
// documentos completos o mezclar mensajes futuros en el contexto de uno
// pasado — cualquiera de las dos rompe la idempotencia que
// rules/ai-cost.md exige (nunca repagar un mensaje ya completado).
//
// Remitentes con etiquetas neutrales ("Participante 1"), mismo criterio
// que Event Detection (knowledge/domain/event-detection.ts): el modelo de
// embeddings no necesita el nombre real para capturar el significado, y
// manda menos datos personales de terceros a un servicio externo
// (rules/security-privacy.md).

/** Mensajes previos incluidos como contexto, además del mensaje ancla. */
export const CONTEXT_WINDOW_SIZE = 2;

export interface ChunkMessage {
  id: string;
  participantId: string;
  content: string;
}

/** Igual criterio que knowledge/use-cases/detect-events.ts: por orden de aparición dentro del chunk, no identidad global. */
function speakerLabels(window: readonly ChunkMessage[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const message of window) {
    if (!labels.has(message.participantId)) {
      labels.set(message.participantId, `Participante ${labels.size + 1}`);
    }
  }
  return labels;
}

/**
 * Texto que se manda a embed(): hasta `CONTEXT_WINDOW_SIZE` mensajes
 * previos (orden cronológico, más antiguo primero) + el mensaje ancla al
 * final. `precedingContext` debe venir ya en orden cronológico ascendente
 * y sin incluir al ancla — el caller (`src/analysis/embeddings.ts`) es
 * quien resuelve esos mensajes contra la base.
 */
export function buildEmbeddingChunkText(
  anchor: ChunkMessage,
  precedingContext: readonly ChunkMessage[]
): string {
  const window = [...precedingContext, anchor];
  const labels = speakerLabels(window);
  return window
    .map((message) => `${labels.get(message.participantId) ?? "Participante ?"}: ${message.content}`)
    .join("\n");
}
