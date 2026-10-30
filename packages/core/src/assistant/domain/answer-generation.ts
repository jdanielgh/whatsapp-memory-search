// Pipeline 12, pasos 5-6 - LLM + Evidence Validation (docs/PIPELINES.md,
// UC-014 y UC-019).
//
// La regla que gobierna este módulo está en docs/VISION.md: "Si el
// sistema no posee suficiente información deberá indicar que no puede
// responder". Y en SI-037: "Toda respuesta debe poder reconstruirse desde
// la evidencia".
//
// Por eso el modelo no devuelve un texto libre: devuelve afirmaciones,
// cada una con los índices de la evidencia que la sostiene. Una
// afirmación sin respaldo válido no se publica como verificada — se
// marca. La validación es determinista y ocurre acá, del lado del
// sistema; no se le pide al modelo que se autoevalúe.

import type { DomainProfile } from "../../shared/domain-profile.js";
import {
  coerceModelArrayField,
  coerceModelBoolean,
  unwrapDoubleEncodedObject,
} from "../../shared/model-json.js";

/** Un elemento de evidencia tal como se le presenta al modelo. */
export interface ContextItem {
  index: number;
  /**
   * Qué clase de fuente respalda este elemento:
   * - "Message": evidencia original, inmutable.
   * - "Event": interpretación derivada, trazable a sus mensajes vía
   *   `event_messages`.
   * - "Statistic": una agregación calculada sobre la conversación
   *   (COUNT/GROUP BY). No se prueba con un mensaje concreto, pero es
   *   igual de verificable: se recalcula corriendo la misma consulta. Sin
   *   esta categoría, toda respuesta a "¿cuántos mensajes hay?" saldría
   *   marcada como no respaldada pese a ser exacta — y un aviso que salta
   *   en respuestas correctas enseña al usuario a ignorarlo, que es
   *   justamente lo que no puede pasar con el único mecanismo que separa
   *   una respuesta fundada de una alucinación.
   */
  sourceType: "Message" | "Event" | "Statistic";
  sourceId: string;
  sentAt: Date;
  speakerLabel: string | null;
  text: string;
  /**
   * Solo para elementos cuyo `text` agrupa VARIOS mensajes con fechas
   * distintas — hoy, las ventanas de Semantic Search (Q-SEM-01). En esos
   * casos `sentAt` es únicamente la fecha del mensaje ancla, así que por
   * sí sola no permite ubicar en la conversación original los otros
   * mensajes de la ventana.
   *
   * NO se le pasa al modelo (`buildAnswerPrompt` la ignora): existe para
   * trazabilidad de quien consuma la respuesta — poder ir al historial en
   * la fecha exacta de cada mensaje citado, no solo la del ancla.
   */
  windowMessages?: Array<{ messageId: string; sentAt: Date }>;
}

export interface Claim {
  statement: string;
  /** Índices del contexto que respaldan la afirmación. */
  evidenceIndices: number[];
}

export interface ValidatedClaim extends Claim {
  /** Ids reales de la evidencia citada, resueltos desde los índices. */
  evidenceIds: string[];
  /**
   * false cuando la afirmación no cita evidencia válida. No se descarta
   * la afirmación: se devuelve marcada, para que quien lea la respuesta
   * vea qué parte no está respaldada en vez de recibir un texto recortado
   * sin explicación.
   */
  supported: boolean;
}

export interface GeneratedAnswer {
  answer: string;
  claims: Claim[];
  /** El propio modelo declara si la evidencia le alcanzó. */
  sufficientEvidence: boolean;
}

export const ANSWER_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    sufficient_evidence: { type: "boolean" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          evidence_indices: { type: "array", items: { type: "integer" } },
        },
        required: ["statement", "evidence_indices"],
      },
    },
  },
  required: ["answer", "sufficient_evidence", "claims"],
};

/** Mismo criterio que en los otros prompts: el contenido no es entrada de confianza. */
function neutralizeDelimiters(text: string): string {
  return text.replace(/<(\/?)evidencia/gi, "‹$1evidencia");
}

export function buildAnswerPrompt(
  question: string,
  context: readonly ContextItem[],
  profile: DomainProfile
): string {
  const rendered = context
    .map((item) => {
      const quien = item.speakerLabel ? ` de="${item.speakerLabel}"` : "";
      return (
        `<evidencia indice="${item.index}" tipo="${item.sourceType}"${quien} fecha="${item.sentAt.toISOString()}">\n` +
        `${neutralizeDelimiters(item.text)}\n</evidencia>`
      );
    })
    .join("\n");

  return `Respondé la pregunta del usuario usando ÚNICAMENTE la evidencia que se lista abajo. Es un archivo de ${profile.conversationContext}.

Los tres campos ("answer", "sufficient_evidence", "claims") son OBLIGATORIOS siempre, incluso cuando hay mucha evidencia. Una respuesta que traiga solo "answer" se descarta entera y no le sirve a nadie.

Reglas obligatorias:
1. No uses conocimiento externo ni supongas nada que no esté en la evidencia. Si la evidencia no alcanza para responder, poné "sufficient_evidence" en false y decilo con claridad en "answer". Es preferible decir que no se puede responder a dar una respuesta que parezca fundada y no lo esté.
2. "answer" es un resumen BREVE: como mucho 4 o 5 frases. No enumeres ahí toda la evidencia ni escribas un informe largo — el detalle va en "claims", una afirmación por hecho. Si hay mucha evidencia, agrupá y resumí en vez de alargar "answer".
3. Descomponé tu respuesta en afirmaciones ("claims"). Cada afirmación debe citar en "evidence_indices" los índices de la evidencia que la respaldan. No cites índices que no aparezcan abajo.
4. Toda afirmación de hecho tiene que estar respaldada. Si querés matizar algo que la evidencia no prueba, no lo pongas como afirmación.
5. Tono neutral y factual. No opines sobre las personas, no atribuyas intenciones y no tomes partido por ninguna de las dos partes.
6. Si la evidencia parece incompleta o recortada, decilo explícitamente en "answer" en vez de responder como si fuera todo lo que existe.
7. Respondé en el mismo idioma de la pregunta.

Pregunta:
"""
${question}
"""

Evidencia disponible:
${rendered}`;
}

class InvalidAnswerResponseError extends Error {}

export function parseAnswerResponse(raw: string): GeneratedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidAnswerResponseError("La respuesta del modelo no es JSON válido.");
  }

  // El modelo a veces mete la respuesta entera dentro de uno de los
  // campos en vez de rellenar el objeto (observado contra la API real,
  // ver src/shared/model-json.ts). Se desenvuelve antes de validar; lo
  // que sigue es igual de estricto que antes.
  const candidate = unwrapDoubleEncodedObject(parsed, "sufficient_evidence");
  if (candidate === null) {
    // Forma observada contra la API real con mucha evidencia (40 ítems):
    // el modelo devuelve SOLO `answer`, con un texto largo en prosa, y se
    // saltea `sufficient_evidence`/`claims`. No es JSON re-codificado
    // (eso ya lo cubre unwrapDoubleEncodedObject), así que no hay nada que
    // desenvolver. Se distingue en el mensaje porque la acción correctiva
    // es otra: acotar la evidencia o insistir en el prompt, no tolerar una
    // forma más. Rechazarla es lo correcto — sin `claims` no se puede
    // validar la evidencia (SI-037) y la respuesta no sería verificable.
    const soloAnswer =
      typeof parsed === "object" &&
      parsed !== null &&
      "answer" in (parsed as Record<string, unknown>);
    throw new InvalidAnswerResponseError(
      soloAnswer
        ? "El modelo devolvió solo 'answer', sin 'sufficient_evidence' ni 'claims': la respuesta no se puede validar contra la evidencia y se descarta."
        : "La respuesta del modelo no declara si la evidencia era suficiente."
    );
  }

  if (typeof candidate.answer !== "string" || candidate.answer.trim() === "") {
    throw new InvalidAnswerResponseError("La respuesta del modelo no incluye texto.");
  }

  // Tolerante a "true"/"false" como string, pero a nada más: este valor
  // decide si la respuesta se presenta como fundada, así que la coerción
  // laxa de JavaScript (cualquier cadena no vacía es true) sería
  // justamente el error que no se puede cometer acá.
  const sufficientEvidence = coerceModelBoolean(candidate.sufficient_evidence);
  if (sufficientEvidence === null) {
    throw new InvalidAnswerResponseError(
      "La respuesta del modelo no declara si la evidencia era suficiente."
    );
  }

  const claims: Claim[] = [];
  const rawClaims = coerceModelArrayField(candidate, "claims");
  if (rawClaims !== null) {
    for (const item of rawClaims) {
      if (typeof item !== "object" || item === null) continue;
      const claim = item as Record<string, unknown>;
      if (typeof claim.statement !== "string" || claim.statement.trim() === "") continue;
      const indices = Array.isArray(claim.evidence_indices)
        ? claim.evidence_indices.filter(
            (i): i is number => typeof i === "number" && Number.isInteger(i)
          )
        : [];
      claims.push({ statement: claim.statement.trim(), evidenceIndices: indices });
    }
  }

  return {
    answer: candidate.answer.trim(),
    claims,
    sufficientEvidence,
  };
}

export interface ValidationResult {
  claims: ValidatedClaim[];
  /** true solo si TODA afirmación cita al menos un índice existente del contexto. */
  fullySupported: boolean;
}

/**
 * Evidence Validation (paso 6 del Pipeline 12).
 *
 * Comprueba que cada afirmación cite evidencia que efectivamente se le
 * entregó al modelo. Un índice inventado o inexistente es señal de
 * alucinación: se descarta la cita y la afirmación queda marcada como no
 * respaldada.
 *
 * Es deliberadamente determinista y del lado del sistema. Pedirle al
 * modelo que verifique su propia respuesta no sirve como control: si se
 * equivocó al responder, puede equivocarse igual al revisarse.
 */
export function validateClaims(
  claims: readonly Claim[],
  context: readonly ContextItem[]
): ValidationResult {
  const byIndex = new Map(context.map((item) => [item.index, item]));

  const validated = claims.map((claim) => {
    const evidenceIds = [
      ...new Set(
        claim.evidenceIndices
          .map((index) => byIndex.get(index)?.sourceId)
          .filter((id): id is string => id !== undefined)
      ),
    ];
    return { ...claim, evidenceIds, supported: evidenceIds.length > 0 };
  });

  return {
    claims: validated,
    // Sin afirmaciones no hay nada verificado: una respuesta que no se
    // descompone en afirmaciones citables no puede considerarse
    // respaldada, aunque suene razonable.
    fullySupported: validated.length > 0 && validated.every((c) => c.supported),
  };
}

export { InvalidAnswerResponseError };
