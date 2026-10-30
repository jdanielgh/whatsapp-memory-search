// Lógica de la calificación de un motor de IA contra una línea base
// (plans/, sección 6). Pura: recibe filas ya leídas y
// devuelve agregados y un veredicto. No imprime ni toca archivos, y nunca
// maneja texto de respuestas más allá de contarlo.
//
// Los UMBRALES están fijados acá ANTES de correr el motor candidato y no se
// ajustan después de ver los resultados. Cambiarlos exige un commit aparte que
// explique por qué.

/** Umbrales de aceptación, relativos a la línea base. */
export const THRESHOLDS = {
  /** Preguntas que terminan con error de motor o de formato (no transitorio). */
  maxHardErrors: 2,
  /** La tasa de respuestas verificadas puede bajar como mucho esto, en puntos porcentuales. */
  maxVerifiedDropPoints: 10,
  /** La tasa de afirmaciones sin respaldo puede subir como mucho esto, en puntos. */
  maxUnsupportedClaimRisePoints: 5,
  /** La tasa de preguntas "no soportadas" puede subir como mucho esto, en puntos. */
  maxNoSoportadoRisePoints: 5,
  /** Mínimo de preguntas donde el intent detectado coincide con la línea base. */
  minIntentAgreement: 0.7,
} as const;

/** Fila del JSONL de la regresión; solo los campos que se usan. */
export interface RegressionRow {
  n: number;
  intent?: string;
  verified?: boolean;
  error?: string;
  claims?: Array<{ supported: boolean }>;
  aiCalls?: number;
  elapsedMs?: number;
}

export interface RunStats {
  answered: number;
  hardErrors: number;
  verifiedRate: number;
  unsupportedClaimRate: number;
  noSoportadoRate: number;
  intents: Map<string, number>;
  avgAiCalls: number;
  avgSeconds: number;
  /** Filas exitosas repetidas para una misma pregunta (debería ser 0: idempotencia). */
  duplicateSuccesses: number;
  byQuestion: Map<number, { intent: string; verified: boolean }>;
}

export function computeStats(rows: readonly RegressionRow[]): RunStats {
  // Una pregunta con filas de error seguidas de una exitosa cuenta como
  // exitosa (error transitorio reintentado). Solo es "duro" si no llegó a
  // responderse.
  const successes = new Map<number, RegressionRow[]>();
  const failed = new Set<number>();
  for (const row of rows) {
    if (typeof row.n !== "number") continue;
    if (row.error) failed.add(row.n);
    else successes.set(row.n, [...(successes.get(row.n) ?? []), row]);
  }

  const finalRows = new Map<number, RegressionRow>();
  let duplicateSuccesses = 0;
  for (const [n, list] of successes) {
    duplicateSuccesses += list.length - 1;
    finalRows.set(n, list[list.length - 1]!);
  }
  const hardErrors = [...failed].filter((n) => !successes.has(n)).length;

  const list = [...finalRows.values()];
  const answered = list.length;
  const claims = list.flatMap((r) => r.claims ?? []);
  const intents = new Map<string, number>();
  for (const r of list) {
    const intent = r.intent ?? "?";
    intents.set(intent, (intents.get(intent) ?? 0) + 1);
  }
  const byQuestion = new Map<number, { intent: string; verified: boolean }>();
  for (const [n, r] of finalRows) {
    byQuestion.set(n, { intent: r.intent ?? "?", verified: Boolean(r.verified) });
  }

  return {
    answered,
    hardErrors,
    verifiedRate: answered ? list.filter((r) => r.verified).length / answered : 0,
    unsupportedClaimRate: claims.length
      ? claims.filter((c) => !c.supported).length / claims.length
      : 0,
    noSoportadoRate: answered ? (intents.get("no_soportado") ?? 0) / answered : 0,
    intents,
    avgAiCalls: answered ? list.reduce((s, r) => s + (r.aiCalls ?? 0), 0) / answered : 0,
    avgSeconds: answered ? list.reduce((s, r) => s + (r.elapsedMs ?? 0), 0) / answered / 1000 : 0,
    duplicateSuccesses,
    byQuestion,
  };
}

export interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}

export function evaluate(baseline: RunStats, candidate: RunStats): Verdict[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const T = THRESHOLDS;

  let agree = 0;
  let compared = 0;
  for (const [n, b] of baseline.byQuestion) {
    const c = candidate.byQuestion.get(n);
    if (!c) continue;
    compared += 1;
    if (c.intent === b.intent) agree += 1;
  }
  const agreement = compared ? agree / compared : 0;

  return [
    {
      name: "errores duros",
      pass: candidate.hardErrors <= T.maxHardErrors,
      detail: `${candidate.hardErrors} (máx ${T.maxHardErrors}; base ${baseline.hardErrors})`,
    },
    {
      name: "respuestas verificadas",
      pass: candidate.verifiedRate >= baseline.verifiedRate - T.maxVerifiedDropPoints / 100,
      detail: `${pct(candidate.verifiedRate)} (base ${pct(baseline.verifiedRate)}, caída máx ${T.maxVerifiedDropPoints} pts)`,
    },
    {
      name: "afirmaciones sin respaldo",
      pass:
        candidate.unsupportedClaimRate <=
        baseline.unsupportedClaimRate + T.maxUnsupportedClaimRisePoints / 100,
      detail: `${pct(candidate.unsupportedClaimRate)} (base ${pct(baseline.unsupportedClaimRate)}, alza máx ${T.maxUnsupportedClaimRisePoints} pts)`,
    },
    {
      name: "preguntas no soportadas",
      pass: candidate.noSoportadoRate <= baseline.noSoportadoRate + T.maxNoSoportadoRisePoints / 100,
      detail: `${pct(candidate.noSoportadoRate)} (base ${pct(baseline.noSoportadoRate)}, alza máx ${T.maxNoSoportadoRisePoints} pts)`,
    },
    {
      name: "coincidencia de intent con la base",
      pass: agreement >= T.minIntentAgreement,
      detail: `${pct(agreement)} de ${compared} preguntas (mín ${pct(T.minIntentAgreement)})`,
    },
    {
      name: "idempotencia (sin respuestas exitosas repetidas)",
      pass: candidate.duplicateSuccesses === 0,
      detail: `${candidate.duplicateSuccesses} repetidas`,
    },
    {
      name: "preguntas respondidas",
      pass: candidate.answered >= baseline.answered - T.maxHardErrors,
      detail: `${candidate.answered} (base ${baseline.answered})`,
    },
  ];
}

export function describeStats(stats: RunStats): string {
  const intents = [...stats.intents]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return (
    `respondidas ${stats.answered} · errores duros ${stats.hardErrors} · ` +
    `verificadas ${(stats.verifiedRate * 100).toFixed(1)}% · ` +
    `sin respaldo ${(stats.unsupportedClaimRate * 100).toFixed(1)}% · ` +
    `${stats.avgAiCalls.toFixed(2)} llamadas/pregunta · ${stats.avgSeconds.toFixed(1)} s/pregunta\n` +
    `  intents: ${intents}`
  );
}
