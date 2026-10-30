// Tolerancia a una forma malformada concreta que devuelve el modelo con
// salida estructurada forzada (tool-use).
//
// Observado contra la API real (smoke test del 2026-08-03, Sonnet 5): en
// vez de
//
//   { "events": [ {...}, {...} ] }
//
// el modelo devolvió a veces
//
//   { "events": "{\"events\": [ {...}, {...} ]}" }
//
// es decir, el campo trae un STRING con todo el JSON re-codificado
// dentro. No es determinista: la misma llamada con una ventana más corta
// respondió bien. Sobre cientos de llamadas aparece de forma
// intermitente, y cada ventana rechazada se reintenta en la corrida
// siguiente, o sea que se paga otra vez.
//
// Se desenvuelve la capa de más, pero NO se relaja nada: lo que salga de
// acá pasa por la misma validación campo a campo que antes. La
// alternativa —rechazar la respuesta— descartaría datos correctos por un
// detalle de serialización.

/**
 * Devuelve el array que el modelo debía poner en `field`, aceptando
 * también que venga envuelto en un string JSON. `null` si no hay forma
 * razonable de interpretarlo como array.
 */
export function coerceModelArrayField(
  container: unknown,
  field: string
): unknown[] | null {
  if (typeof container !== "object" || container === null) return null;
  const value = (container as Record<string, unknown>)[field];

  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;

  let inner: unknown;
  try {
    inner = JSON.parse(value);
  } catch {
    return null;
  }

  // El string puede contener directamente el array...
  if (Array.isArray(inner)) return inner;
  // ...o el objeto entero otra vez, con el mismo campo dentro.
  if (typeof inner === "object" && inner !== null) {
    const nested = (inner as Record<string, unknown>)[field];
    if (Array.isArray(nested)) return nested;
  }
  return null;
}

/**
 * Misma tolerancia, para objetos: si `parsed` no trae `requiredKey` pero
 * alguno de sus valores es un string que se parsea a un objeto que sí lo
 * trae, devuelve ese objeto.
 *
 * Cubre la variante en que el modelo mete la respuesta entera dentro de
 * uno de los campos en vez de rellenar el objeto.
 */
export function unwrapDoubleEncodedObject(
  parsed: unknown,
  requiredKey: string
): Record<string, unknown> | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (requiredKey in obj) return obj;

  for (const value of Object.values(obj)) {
    if (typeof value !== "string") continue;
    try {
      const inner: unknown = JSON.parse(value);
      if (typeof inner === "object" && inner !== null && requiredKey in inner) {
        return inner as Record<string, unknown>;
      }
    } catch {
      // No era JSON: se sigue probando con los demás campos.
    }
  }
  return null;
}

/**
 * Booleano tolerante a que el modelo lo mande como el string "true" o
 * "false".
 *
 * Deliberadamente estricto con todo lo demás: este valor decide si una
 * respuesta se presenta como fundada, así que interpretar cualquier
 * cadena no vacía como `true` (la coerción habitual de JavaScript) sería
 * exactamente el error que no se puede cometer acá. Cualquier otra cosa
 * devuelve null y quien llame decide rechazar.
 */
export function coerceModelBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
