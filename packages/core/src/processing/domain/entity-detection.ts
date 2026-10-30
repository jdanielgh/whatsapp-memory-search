// Pipeline 4 - Entity Detection (docs/PIPELINES.md, UC-006). Con IA
// (tier "cheap" — docs/DECISIONS.md). Construye el prompt, define el
// esquema forzado de salida, y valida la respuesta del modelo antes de
// persistir — "Toda respuesta proveniente de un proveedor externo debe
// validarse antes de incorporarse al sistema" (docs/SECURITY.md,
// "Dependencias Externas").
//
// Se analizan VARIOS mensajes por llamada, no uno por uno. Con mensajes
// de ~40 caracteres de promedio, una llamada por mensaje paga el prompt
// de instrucciones completo (~450 tokens) para analizar ~15 tokens de
// contenido: el 97% del gasto de entrada es overhead repetido. La caché
// de prompt no lo resuelve — el mínimo cacheable de Haiku 4.5 son 4.096
// tokens y este prefijo no llega —, así que agrupar es la única palanca
// real (ver rules/ai-cost.md).

import type { DomainProfile } from "../../shared/domain-profile.js";
import { coerceModelArrayField } from "../../shared/model-json.js";

// Enum autoritativo: docs/DOMAIN_MODEL.md ("Entity", ubiquitous
// language) y docs/DATA_MODEL.md (message_entities.entity_type).
// docs/PIPELINES.md y docs/USE_CASES.md listan ejemplos distintos
// (organización/cantidad/teléfono/correo) — son ilustrativos, no el
// enum real; no se usan acá.
export const ENTITY_TYPES = [
  "persona",
  "lugar",
  "fecha",
  "hora",
  "institución",
  "actividad",
  "dinero",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface DetectedEntity {
  entityType: EntityType;
  value: string;
  normalizedValue: string | null;
}

/** Un mensaje dentro del lote. `index` es su posición (1-based) en ESTE lote, no un id del sistema. */
export interface EntityDetectionBatchItem {
  index: number;
  content: string;
}

/** Pasado como CompletionOptions.jsonSchema (AnthropicProvider fuerza tool-use con esto). */
export const ENTITY_DETECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_index: { type: "integer" },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entity_type: { type: "string", enum: ENTITY_TYPES },
                value: { type: "string" },
                normalized_value: { type: ["string", "null"] },
              },
              required: ["entity_type", "value"],
            },
          },
        },
        required: ["message_index", "entities"],
      },
    },
  },
  required: ["messages"],
};

/**
 * Neutraliza los delimitadores del prompt dentro del contenido.
 *
 * El contenido de un mensaje es texto de un tercero real, no una entrada
 * de confianza (`docs/SECURITY.md`: toda entrada externa se valida antes
 * de usarse). Al analizar de a un mensaje por llamada esto no importaba
 * — no había otro mensaje al que contaminar—, pero dentro de un lote un
 * contenido que incluya `</mensaje><mensaje indice="2">` puede fabricar
 * estructura y hacer que el modelo atribuya las entidades de un mensaje
 * a otro del mismo lote. La validación de índices no alcanza: descarta
 * los índices ajenos al lote, no los que sí le pertenecen.
 *
 * Se sustituye el carácter que abre la etiqueta, no el texto completo:
 * conserva el mensaje legible para el modelo (y por lo tanto las
 * entidades reales que contenga) sin dejarle cerrar el bloque.
 */
function neutralizeDelimiters(content: string): string {
  return content.replace(/<(\/?)mensaje/gi, "‹$1mensaje");
}

export function buildEntityDetectionPrompt(
  batch: readonly EntityDetectionBatchItem[],
  profile: DomainProfile
): string {
  const numbered = batch
    .map(
      (item) =>
        `<mensaje indice="${item.index}">\n${neutralizeDelimiters(item.content)}\n</mensaje>`
    )
    .join("\n");

  return `Analiza los siguientes mensajes de ${profile.conversationContext}, y extrae las entidades mencionadas en cada uno.

Tipos de entidad válidos (usar exactamente uno de estos valores en entity_type):
- persona: nombres propios de personas mencionadas.
- lugar: lugares físicos (ciudades, direcciones, locales, etc.).
- fecha: fechas mencionadas, en cualquier formato en que aparezcan.
- hora: horarios mencionados.
- institución: empresas, hospitales, organizaciones nombradas.
- actividad: actividades o planes mencionados (cumpleaños, partido, viaje, etc.).
- dinero: montos o menciones de dinero/pagos.

Para cada entidad: "value" es el texto exacto tal como aparece en el
mensaje. "normalized_value" es una forma normalizada si es posible con
certeza (ej. una fecha a ISO 8601), o null si no aplica o no se puede
normalizar sin ambigüedad.

Reglas obligatorias de salida:
1. Devolvé exactamente una entrada por cada mensaje recibido, incluso si
   ese mensaje no menciona ninguna entidad — en ese caso su lista
   "entities" va vacía. No omitas mensajes.
2. "message_index" debe ser el mismo número del atributo "indice" del
   mensaje analizado. No los reordenes ni los renumeres.
3. Analizá cada mensaje por separado: no atribuyas a un mensaje una
   entidad que aparece en otro, aunque estén relacionados.
4. No inventes entidades que no estén explícitamente en el texto — si hay
   duda, no la incluyas.

Mensajes:
${numbered}`;
}

class InvalidEntityDetectionResponseError extends Error {}

function isEntityType(value: unknown): value is EntityType {
  return (
    typeof value === "string" &&
    (ENTITY_TYPES as readonly string[]).includes(value)
  );
}

function parseEntities(raw: unknown): DetectedEntity[] {
  if (!Array.isArray(raw)) return [];
  const result: DetectedEntity[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (!isEntityType(candidate.entity_type)) continue;
    if (typeof candidate.value !== "string" || candidate.value.trim() === "") {
      continue;
    }
    result.push({
      entityType: candidate.entity_type,
      value: candidate.value,
      normalizedValue:
        typeof candidate.normalized_value === "string"
          ? candidate.normalized_value
          : null,
    });
  }
  return result;
}

/**
 * Valida la respuesta del modelo antes de persistir.
 *
 * Tres niveles distintos de rigor, a propósito:
 * - Forma top-level inválida (no es JSON, o no trae "messages" como
 *   array) → se rechaza todo el lote. Es una falla de integración real,
 *   no un dato parcial aceptable.
 * - Entrada con un `message_index` que no pertenece a este lote (o
 *   repetido) → se descarta esa entrada. Aceptarla escribiría entidades
 *   en el mensaje equivocado, que es peor que no escribir ninguna:
 *   contaminaría evidencia derivada con contenido de otra conversación
 *   ajena a ese mensaje.
 * - Entidad individual con forma inválida → se descarta esa entidad sola;
 *   el resto del mensaje se conserva.
 *
 * Los índices que el modelo no devolvió simplemente no aparecen en el
 * Map. Quien llama decide qué hacer con ellos — no se asume "sin
 * entidades", porque "el modelo no contestó por este mensaje" y "este
 * mensaje no tiene entidades" no son lo mismo (PL-004).
 */
export function parseEntityDetectionResponse(
  raw: string,
  expectedIndices: readonly number[]
): Map<number, DetectedEntity[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidEntityDetectionResponseError(
      "La respuesta del modelo no es JSON válido."
    );
  }

  // Mismo caso que en Event Detection: el modelo puede devolver el array
  // envuelto en un string JSON (ver src/shared/model-json.ts). Se
  // desenvuelve; la validación campo a campo de abajo no cambia.
  const rawMessages = coerceModelArrayField(parsed, "messages");
  if (rawMessages === null) {
    throw new InvalidEntityDetectionResponseError(
      'La respuesta del modelo no tiene la forma esperada ({ messages: [...] }).'
    );
  }

  const expected = new Set(expectedIndices);
  const byIndex = new Map<number, DetectedEntity[]>();

  for (const item of rawMessages) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const index = candidate.message_index;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    // Fuera del lote o duplicado: descartar. Un índice repetido es
    // ambiguo (¿cuál de las dos listas vale?) y quedarse con una sería
    // elegir al azar sobre evidencia.
    if (!expected.has(index) || byIndex.has(index)) continue;
    byIndex.set(index, parseEntities(candidate.entities));
  }

  return byIndex;
}

export { InvalidEntityDetectionResponseError };
