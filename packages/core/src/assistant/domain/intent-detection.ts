// Pipeline 12, paso 1 - Intent Detection (docs/PIPELINES.md, UC-014).
//
// Clasifica la pregunta del usuario en uno de los intents ya mapeados en
// docs/QUERY_CATALOG.md y extrae sus parámetros. El Agent Layer nunca
// construye SQL ni decide tablas (SI-041): traduce el intent a llamadas
// del Search Layer, y nada más.
//
// "buscar_por_tema" (Semantic Search, Q-SEM-01) se resuelve con
// similitud, no con palabras exactas — SI-036 exige que siga siendo un
// intent aparte de "buscar_por_texto", nunca un reemplazo silencioso:
// una pregunta literal ("mensajes que digan X") tiene que seguir yendo
// por Exact Search aunque Semantic Search también pudiera responderla.

import type { DomainProfile } from "../../shared/domain-profile.js";

export const INTENTS = [
  "buscar_por_texto",
  "buscar_por_fecha",
  "buscar_por_rango",
  "cronologia",
  "sobre_un_case",
  "buscar_por_tema",
  "estadisticas",
  "no_soportado",
] as const;

export type Intent = (typeof INTENTS)[number];

export interface DetectedIntent {
  intent: Intent;
  /** Texto a buscar (buscar_por_texto) o tema del Case (sobre_un_case). */
  text: string | null;
  /** Fecha concreta en ISO YYYY-MM-DD (buscar_por_fecha). */
  date: string | null;
  /** Extremos del rango en ISO YYYY-MM-DD (buscar_por_rango, cronologia). */
  from: string | null;
  to: string | null;
  /** Por qué no se puede responder, cuando intent es "no_soportado". */
  reason: string | null;
}

export const INTENT_DETECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    text: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    from: { type: ["string", "null"] },
    to: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
  },
  required: ["intent"],
};

/**
 * `today` se inyecta para poder resolver expresiones relativas ("la
 * semana pasada") sin que el modelo tenga que adivinar la fecha actual, y
 * para que los tests sean deterministas.
 */
export function buildIntentDetectionPrompt(
  question: string,
  today: Date,
  profile: DomainProfile
): string {
  const anchorExamples = profile.intentExamples
    .map((example) => `"${example.question}" → text="${example.text}"`)
    .join("; ");

  return `Clasificá la siguiente pregunta sobre un archivo de ${profile.conversationContext} en uno de los intents disponibles, y extraé sus parámetros.

La fecha de hoy es ${today.toISOString().slice(0, 10)}. Usala para resolver expresiones relativas como "la semana pasada" o "el mes pasado".

Intents disponibles:
- buscar_por_texto: la pregunta trae una palabra o frase concreta que probablemente aparece TAL CUAL en los mensajes (un nombre, lugar, objeto, actividad o tema nombrado explícitamente), aunque esté fraseada como pedido de tema (ej. ${anchorExamples}). Poné en "text" esa palabra clave, sin signos de puntuación ni palabras de relleno. Es el intent por defecto cuando existe una palabra ancla.
- buscar_por_fecha: la pregunta se refiere a un día concreto. Poné ese día en "date" con formato YYYY-MM-DD.
- buscar_por_rango: la pregunta se refiere a un período. Poné los extremos en "from" y "to" con formato YYYY-MM-DD.
- cronologia: la pregunta pide la secuencia de hechos de un período. Poné los extremos en "from" y "to".
- sobre_un_case: la pregunta es sobre un tema o asunto YA FORMALIZADO como Case (categorías: ${profile.caseCategories.join(", ")}) y pide su seguimiento a lo largo del tiempo. Poné en "text" las palabras que identifican el tema/categoría.
- buscar_por_tema: la pregunta NO trae ninguna palabra ancla que sirva como término literal — hace falta entender SIGNIFICADO, tono o relaciones que la pregunta no nombra directamente (ej. "¿en qué momento se puso tenso?" sin que "tenso" sea necesariamente la palabra que se usó; "¿hubo algo raro esa semana?"). Poné en "text" una descripción breve del tema a buscar.
- estadisticas: la pregunta pide un conteo o una métrica general (cuántos mensajes, quién escribió más, cuántos temas abiertos).
- no_soportado: la pregunta no se puede responder con los intents anteriores. Explicá brevemente por qué en "reason".

Reglas:
1. Elegí exactamente un intent.
2. No inventes fechas que la pregunta no menciona ni implica. Si la pregunta no acota un período, dejá "from" y "to" en null.
3. Antes de elegir entre "buscar_por_texto" y "buscar_por_tema", preguntate: ¿hay una palabra o frase concreta en la pregunta que serviría como término de búsqueda literal? Si sí, "buscar_por_texto" — no importa que la pregunta esté fraseada como pedido de tema. Usá "buscar_por_tema" solo si ninguna palabra de la pregunta serviría como ancla literal. SI-036: la búsqueda semántica nunca reemplaza a la literal cuando hay una palabra ancla disponible.
4. Reservá "no_soportado" para lo que ninguna búsqueda puede resolver: preguntas que no son sobre la conversación, que piden una opinión/juicio de valor, o que piden predecir algo que todavía no pasó.

Pregunta:
"""
${question}
"""`;
}

class InvalidIntentResponseError extends Error {}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Acepta solo YYYY-MM-DD y valida que sea una fecha real (rechaza 2025-02-31). */
function optionalIsoDate(value: unknown): string | null {
  const raw = optionalString(value);
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `new Date("2025-02-31")` no falla: rueda a marzo. Comparar de vuelta
  // es la forma de detectar una fecha que no existe.
  return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

export function parseIntentDetectionResponse(raw: string): DetectedIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidIntentResponseError("La respuesta del modelo no es JSON válido.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidIntentResponseError("La respuesta del modelo no es un objeto.");
  }

  const candidate = parsed as Record<string, unknown>;
  const intent = candidate.intent;
  if (
    typeof intent !== "string" ||
    !(INTENTS as readonly string[]).includes(intent)
  ) {
    throw new InvalidIntentResponseError(
      `El intent devuelto no es válido: ${String(intent)}.`
    );
  }

  return {
    intent: intent as Intent,
    text: optionalString(candidate.text),
    date: optionalIsoDate(candidate.date),
    from: optionalIsoDate(candidate.from),
    to: optionalIsoDate(candidate.to),
    reason: optionalString(candidate.reason),
  };
}

export { InvalidIntentResponseError };
