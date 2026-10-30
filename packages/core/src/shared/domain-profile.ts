// Perfil de dominio (plans/): todo lo que
// cambia entre un uso y otro de la app — el contexto que se inyecta en los
// prompts, las categorías de Case, las dimensiones de análisis y los plazos
// de continuidad — vive acá y no en constantes del dominio.
//
// Puro: no lee archivos ni variables de entorno (eso es
// `domain-profile-loader.ts`), así los prompts y parsers siguen siendo
// testeables con un perfil inventado.

export interface IntentExample {
  question: string;
  /** Palabra ancla que debería extraerse de la pregunta. */
  text: string;
}

export interface DomainProfile {
  id: string;
  /** Sube con cualquier cambio de contenido; se persiste en `prompt_version`. */
  version: number;
  /** Sintagma nominal que sigue a "de"/"sobre" en los prompts ("una conversación de WhatsApp ..."). */
  conversationContext: string;
  caseCategories: readonly string[];
  /** Categoría de descarte: debe estar en `caseCategories`. */
  catchAllCategory: string;
  analysisDimensions: readonly string[];
  caseContinuityDays: number;
  catchAllContinuityDays: number;
  intentExamples: readonly IntentExample[];
}

export class InvalidDomainProfileError extends Error {}

function fail(field: string, reason: string): never {
  throw new InvalidDomainProfileError(`Perfil de dominio inválido: "${field}" ${reason}.`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(field, "debe ser un texto no vacío");
  return value.trim();
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(field, "debe ser un número positivo");
  }
  return value;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(field, "debe ser una lista no vacía");
  const items = value.map((item, i) => nonEmptyString(item, `${field}[${i}]`));
  if (new Set(items).size !== items.length) fail(field, "no puede tener valores repetidos");
  return items;
}

/**
 * Valida un perfil leído de una fuente externa (archivo) antes de usarlo
 * (rules/security-privacy.md regla 6). Un perfil inválido aborta: nunca se
 * cae en silencio al perfil genérico, porque eso cambiaría los prompts sin
 * que quien corre el pipeline lo note.
 */
export function parseDomainProfile(raw: unknown): DomainProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("(raíz)", "debe ser un objeto");
  }
  const obj = raw as Record<string, unknown>;

  const caseCategories = uniqueStrings(obj.caseCategories, "caseCategories");
  const catchAllCategory = nonEmptyString(obj.catchAllCategory, "catchAllCategory");
  if (!caseCategories.includes(catchAllCategory)) {
    fail("catchAllCategory", "debe estar incluida en caseCategories");
  }

  const version = positiveNumber(obj.version, "version");
  if (!Number.isInteger(version)) fail("version", "debe ser un entero");

  if (!Array.isArray(obj.intentExamples) || obj.intentExamples.length === 0) {
    fail("intentExamples", "debe ser una lista no vacía");
  }
  const intentExamples = obj.intentExamples.map((item, i): IntentExample => {
    if (typeof item !== "object" || item === null) fail(`intentExamples[${i}]`, "debe ser un objeto");
    const example = item as Record<string, unknown>;
    return {
      question: nonEmptyString(example.question, `intentExamples[${i}].question`),
      text: nonEmptyString(example.text, `intentExamples[${i}].text`),
    };
  });

  return {
    id: nonEmptyString(obj.id, "id"),
    version,
    conversationContext: nonEmptyString(obj.conversationContext, "conversationContext"),
    caseCategories,
    catchAllCategory,
    analysisDimensions: uniqueStrings(obj.analysisDimensions, "analysisDimensions"),
    caseContinuityDays: positiveNumber(obj.caseContinuityDays, "caseContinuityDays"),
    catchAllContinuityDays: positiveNumber(obj.catchAllContinuityDays, "catchAllContinuityDays"),
    intentExamples,
  };
}

/** Identificador del perfil para `prompt_version` (SI-020): `<base>+<id>@<version>`. */
export function withProfileVersion(basePromptVersion: string, profile: DomainProfile): string {
  return `${basePromptVersion}+${profile.id}@${profile.version}`;
}
