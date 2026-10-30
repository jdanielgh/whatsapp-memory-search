// Pipeline 5 - Event Detection (docs/PIPELINES.md, UC-007). Con IA
// (tier "default" — Sonnet; docs/DECISIONS.md priorizó calidad sobre
// costo acá porque un Event mal clasificado alimenta Case Resolution e
// Insights, sobre una conversación que podría usarse como evidencia,
// rules/security-privacy.md regla 7).
//
// Se analiza una VENTANA de mensajes consecutivos por llamada, no un
// mensaje aislado: un Event puede respaldarse en varios Message (SI-014)
// y la coordinación de planes entre personas rara vez cabe en un solo mensaje
// ("¿te va bien el sábado?" / "ese día no puedo" es propuesta + rechazo
// repartido en dos). Analizar de a uno haría estructuralmente imposible
// detectar esos pares.

import type { DomainProfile } from "../../shared/domain-profile.js";
import { coerceModelArrayField } from "../../shared/model-json.js";

// `events.type` es autoritativo en docs/DATA_MODEL.md y es común a todo
// dominio. `cases.category` y `analyses.dimension` salen del perfil de
// dominio (shared/domain-profile.ts): en la base son texto libre.
export const EVENT_TYPES = [
  "propuesta",
  "aceptación",
  "rechazo",
  "cambio_horario",
  "discusión",
  "acuerdo",
  "cancelación",
  "actividad",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
/** Valor de `DomainProfile.caseCategories`. */
export type CaseCategory = string;
/** Valor de `DomainProfile.analysisDimensions`. */
export type AnalysisDimension = string;

/** Un mensaje dentro de la ventana. `index` es su posición (1-based) en ESTA ventana. */
export interface EventDetectionWindowItem {
  index: number;
  /** Etiqueta neutral del remitente ("Participante 1"), no su nombre real — ver buildEventDetectionPrompt. */
  speakerLabel: string;
  sentAt: Date;
  content: string;
}

export interface DetectedAnalysis {
  dimension: AnalysisDimension;
  /** 0..1 */
  score: number;
}

export interface DetectedEvent {
  type: EventType;
  category: CaseCategory;
  /** Título corto del tema, usado para nombrar el Case si hay que crear uno. */
  title: string;
  /** Índices (dentro de la ventana) de los mensajes que respaldan el Event. Nunca vacío (SI-014). */
  messageIndices: number[];
  /** Frase que resume la interpretación — se persiste como Observation. */
  observation: string;
  /** 0..1 */
  confidence: number;
  analyses: DetectedAnalysis[];
}

/** Pasado como CompletionOptions.jsonSchema (AnthropicProvider fuerza tool-use con esto). */
export function buildEventDetectionJsonSchema(profile: DomainProfile) {
  return {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: EVENT_TYPES },
            category: { type: "string", enum: profile.caseCategories },
            title: { type: "string" },
            message_indices: { type: "array", items: { type: "integer" } },
            observation: { type: "string" },
            confidence: { type: "number" },
            analyses: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  dimension: { type: "string", enum: profile.analysisDimensions },
                  score: { type: "number" },
                },
                required: ["dimension", "score"],
              },
            },
          },
          required: [
            "type",
            "category",
            "title",
            "message_indices",
            "observation",
            "confidence",
          ],
        },
      },
    },
    required: ["events"],
  };
}

/** Mismo criterio que Entity Detection: el contenido es texto de un tercero, no entrada de confianza. */
function neutralizeDelimiters(content: string): string {
  return content.replace(/<(\/?)mensaje/gi, "‹$1mensaje");
}

/**
 * Arma el prompt de una ventana.
 *
 * Los remitentes van con etiquetas neutrales ("Participante 1"), no con
 * su nombre real: el modelo no necesita saber quién es quién para
 * clasificar el tipo de evento, y la atribución real se reconstruye
 * después desde `event_messages` → `messages.participant_id`, que es
 * evidencia. Manda menos datos personales de terceros a un servicio
 * externo (`rules/security-privacy.md`) y de paso gasta menos tokens.
 */
export function buildEventDetectionPrompt(
  window: readonly EventDetectionWindowItem[],
  profile: DomainProfile
): string {
  const numbered = window
    .map(
      (item) =>
        `<mensaje indice="${item.index}" de="${item.speakerLabel}" fecha="${item.sentAt.toISOString()}">\n` +
        `${neutralizeDelimiters(item.content)}\n</mensaje>`
    )
    .join("\n");

  return `Analizá el siguiente fragmento de ${profile.conversationContext}. Identificá los eventos relevantes del dominio.

Tipos de evento válidos (usar exactamente uno en "type"):
- propuesta: alguien propone un plan, fecha, horario o arreglo.
- aceptación: alguien acepta una propuesta previa.
- rechazo: alguien rechaza o dice que no puede.
- cambio_horario: se modifica un horario o fecha ya acordada.
- discusión: intercambio con desacuerdo o tensión explícita.
- acuerdo: las partes cierran un acuerdo concreto.
- cancelación: se cancela algo previamente acordado.
- actividad: se menciona una actividad concreta que ocurrió u ocurrirá.

Categorías válidas para "category" (el tema al que pertenece el evento):
${profile.caseCategories.join(", ")}.

Dimensiones válidas para "analyses" (opcional, solo si el fragmento da
evidencia clara): ${profile.analysisDimensions.join(", ")}. "score" va de 0 a 1.

Reglas obligatorias de salida:
1. "message_indices" lista los índices de los mensajes que respaldan el
   evento, y NUNCA puede ir vacía: un evento sin mensajes que lo
   respalden no es admisible. Incluí todos los mensajes que hagan falta
   para sostenerlo (una propuesta y su aceptación pueden ser dos).
2. Usá los números del atributo "indice". No los reordenes ni inventes
   índices que no estén en el fragmento.
3. "title" es un título corto del tema (3 a 8 palabras), no un resumen
   del mensaje. Sirve para agrupar eventos del mismo asunto.
4. "observation" es una frase que explique qué pasó, en tono neutral y
   factual. No opines ni tomes partido por ninguna de las dos personas.
5. "confidence" de 0 a 1 refleja qué tan seguro estás de la
   clasificación. Si dudás entre dos tipos, elegí uno y bajá la
   confianza.
6. Si el fragmento no contiene ningún evento relevante, devolvé una
   lista vacía. No fuerces eventos que no están: es preferible no
   detectar un evento a inventar uno.
7. Cuando alguien propone algo y la otra persona responde, son DOS
   eventos, no uno: la propuesta y, por separado, la aceptación o el
   rechazo. No los fusiones en un solo evento de más alto nivel ni los
   resumas como "discusión" o "actividad". Saber quién aceptó o rechazó
   qué, y cuándo, es el objetivo principal de este análisis; un
   intercambio consolidado en un único evento pierde esa información y no
   se puede recuperar después.
8. Etiquetá "actividad" solo cuando no haya un tipo más específico que
   aplique. Es el tipo menos informativo de todos.

Fragmento:
${numbered}`;
}

class InvalidEventDetectionResponseError extends Error {}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseAnalyses(raw: unknown, profile: DomainProfile): DetectedAnalysis[] {
  if (!Array.isArray(raw)) return [];
  const result: DetectedAnalysis[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (!isOneOf(candidate.dimension, profile.analysisDimensions)) continue;
    if (!isUnitInterval(candidate.score)) continue;
    // Una dimensión repetida para el mismo Event es ambigua (¿cuál score
    // vale?): se conserva la primera y se descarta el resto.
    if (seen.has(candidate.dimension)) continue;
    seen.add(candidate.dimension);
    result.push({ dimension: candidate.dimension, score: candidate.score });
  }
  return result;
}

/**
 * Valida la respuesta del modelo antes de persistir (docs/SECURITY.md,
 * "Dependencias Externas").
 *
 * Dos niveles: una forma top-level inválida rechaza toda la ventana (es
 * una falla de integración real); un evento individual malformado se
 * descarta solo él, sin perder los demás eventos de la ventana.
 *
 * El filtro más importante es el de `message_indices`: un Event sin
 * mensajes de respaldo viola SI-014 y sería una interpretación sin
 * evidencia, exactamente lo que este sistema no puede producir.
 */
export function parseEventDetectionResponse(
  raw: string,
  validIndices: readonly number[],
  profile: DomainProfile
): DetectedEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidEventDetectionResponseError(
      "La respuesta del modelo no es JSON válido."
    );
  }

  // Acepta también el caso, observado contra la API real, en que el
  // modelo devuelve el array envuelto en un string JSON. Ver
  // src/shared/model-json.ts: se desenvuelve, no se relaja la validación.
  const rawEvents = coerceModelArrayField(parsed, "events");
  if (rawEvents === null) {
    throw new InvalidEventDetectionResponseError(
      'La respuesta del modelo no tiene la forma esperada ({ events: [...] }).'
    );
  }

  const allowed = new Set(validIndices);
  const result: DetectedEvent[] = [];

  for (const item of rawEvents) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (!isOneOf(candidate.type, EVENT_TYPES)) continue;
    if (!isOneOf(candidate.category, profile.caseCategories)) continue;
    if (typeof candidate.title !== "string" || candidate.title.trim() === "") continue;
    if (typeof candidate.observation !== "string" || candidate.observation.trim() === "") {
      continue;
    }
    if (!isUnitInterval(candidate.confidence)) continue;

    if (!Array.isArray(candidate.message_indices)) continue;
    const indices = [
      ...new Set(
        candidate.message_indices.filter(
          (i): i is number => typeof i === "number" && Number.isInteger(i) && allowed.has(i)
        )
      ),
    ].sort((a, b) => a - b);
    // SI-014: nunca un Event sin evidencia. Si el modelo citó solo
    // índices inexistentes, el evento se descarta entero — no se
    // "rescata" colgándolo de un mensaje arbitrario.
    if (indices.length === 0) continue;

    result.push({
      type: candidate.type,
      category: candidate.category,
      title: candidate.title.trim(),
      messageIndices: indices,
      observation: candidate.observation.trim(),
      confidence: candidate.confidence,
      analyses: parseAnalyses(candidate.analyses, profile),
    });
  }

  return result;
}

export { InvalidEventDetectionResponseError };
