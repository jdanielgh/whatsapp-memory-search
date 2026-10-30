// Pipeline 6 - Case Resolution (docs/PIPELINES.md, UC-008). Decide si un
// Event detectado pertenece a un Case existente o abre uno nuevo.
//
// Determinista, sin IA. `plans/` la señala como
// "la pieza con más ambigüedad de todo el pipeline" y pide documentar el
// criterio elegido en vez de dejarlo implícito en el código; la
// justificación completa está en docs/DECISIONS.md.
//
// El criterio NO usa embeddings: la similitud se calcula con categoría +
// cercanía temporal + solapamiento de palabras del título. La fase 05 ya
// existe (hay embeddings de Message), pero Case Resolution corre DENTRO
// de Event Detection, antes de que un Case tenga vector propio — Q-SEM-02
// (embeddings de Case) sigue sin implementarse. Revisar este criterio si
// alguna vez se generan.

import type { DomainProfile } from "../../shared/domain-profile.js";
import type { CaseCategory } from "./event-detection.js";

export interface OpenCaseSummary {
  id: string;
  title: string;
  category: CaseCategory;
  /** Fecha del Event más reciente del Case; null si todavía no tiene ninguno. */
  lastEventAt: Date | null;
}

export type CaseResolution =
  | { kind: "existing"; caseId: string }
  | { kind: "new"; title: string; category: CaseCategory };

// Ventana de continuidad (`profile.caseContinuityDays`): un Event se
// considera parte de un Case abierto de la misma categoría si el Case tuvo
// actividad dentro de este plazo.
//
// Conviene que sea generosa. Los asuntos de una conversación son cíclicos
// (se renegocian mes a mes y reaparecen), así que una ventana corta
// fragmentaría un mismo asunto en decenas de Cases y haría inútil UC-011
// ("consultar un Case"). El error opuesto —mezclar dos asuntos distintos
// de la misma categoría— es menos grave y más fácil de detectar leyendo el
// Case. El valor concreto lo fija cada perfil de dominio.

/**
 * Solapamiento mínimo de palabras significativas entre el título del
 * Event y el del Case para considerarlos el mismo asunto cuando la
 * cercanía temporal por sí sola no alcanza.
 */
const MIN_TITLE_OVERLAP = 2;

/** Palabras demasiado frecuentes para aportar señal de que dos títulos hablan del mismo tema. */
const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
  "y", "o", "a", "en", "con", "por", "para", "que", "se", "su", "sus",
  "al", "lo", "es", "son", "sobre", "sin", "the", "of",
]);

function significantWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFD") // separa la tilde de la letra para poder quitarla
      .replace(/[̀-ͯ]/g, "") // sin tildes: "reunión" y "reunion" son la misma palabra
      .split(/[^a-z0-9ñ]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Categoría de descarte (`profile.catchAllCategory`). Agrupa lo que no
 * encaja en ningún tema concreto, así que usa una ventana de continuidad
 * mucho más corta (`profile.catchAllContinuityDays`).
 *
 * Medido sobre 1.000 mensajes reales (docs/DECISIONS.md, 2026-08-03): con
 * una ventana normal de 45 días, un único Case de descarte absorbió 80
 * eventos —el 41% del total— a lo largo de más de un año. El efecto se retroalimenta:
 * cada evento nuevo le refresca la fecha de actividad y lo mantiene vivo
 * indefinidamente. El resultado no es "un tema que evoluciona en el
 * tiempo" (docs/AGGREGATES.md) sino un cajón de sastre que deja
 * inservible UC-011.
 *
 * Pero quitarle la cercanía por completo cambia un modo de fallo por el
 * contrario: cada evento con título distinto abriría su propio Case, y
 * sobre miles de mensajes eso son cientos de Cases de un solo evento.
 *
 * El punto intermedio es lo defendible: en `otro` no hay un asunto cuya
 * continuidad medir a lo largo de meses, pero sí existe el intercambio
 * puntual de unos pocos días sobre algo que no encaja en ninguna
 * categoría. Una semana agrupa eso sin construir un almacén de más de un año.
 */

/**
 * Elige el Case para un Event.
 *
 * Orden de preferencia, de más a menos específico:
 * 1. Misma categoría + títulos que comparten palabras significativas.
 *    Gana sobre la cercanía temporal porque dos asuntos distintos de la
 *    misma categoría pueden convivir en el tiempo ("vacaciones de
 *    verano" y "vacaciones de Navidad").
 * 2. Misma categoría + actividad reciente (dentro de
 *    `profile.caseContinuityDays`), salvo en la categoría de descarte
 *    (ver arriba).
 * 3. Ninguno: se abre un Case nuevo.
 *
 * Ante empate gana el Case con actividad más reciente — es el que el
 * usuario tiene presente y el que más probablemente continúa.
 */
export function resolveCase(
  event: { category: CaseCategory; title: string; occurredAt: Date },
  openCases: readonly OpenCaseSummary[],
  profile: DomainProfile
): CaseResolution {
  const sameCategory = openCases.filter((c) => c.category === event.category);
  if (sameCategory.length === 0) {
    return { kind: "new", title: event.title, category: event.category };
  }

  const eventWords = significantWords(event.title);

  const byRecencyDesc = [...sameCategory].sort(
    (a, b) => (b.lastEventAt?.getTime() ?? 0) - (a.lastEventAt?.getTime() ?? 0)
  );

  const byTitle = byRecencyDesc.find(
    (c) => overlap(eventWords, significantWords(c.title)) >= MIN_TITLE_OVERLAP
  );
  if (byTitle) return { kind: "existing", caseId: byTitle.id };

  const continuityDays =
    event.category === profile.catchAllCategory
      ? profile.catchAllContinuityDays
      : profile.caseContinuityDays;

  const byRecency = byRecencyDesc.find(
    (c) =>
      c.lastEventAt !== null &&
      daysBetween(c.lastEventAt, event.occurredAt) <= continuityDays
  );
  if (byRecency) return { kind: "existing", caseId: byRecency.id };

  return { kind: "new", title: event.title, category: event.category };
}
