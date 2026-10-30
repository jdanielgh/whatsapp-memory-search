// Esta lógica decide si se cambia el motor por defecto del sistema: un error
// acá aprobaría un motor malo o rechazaría uno bueno sin que nadie lo note.
// Filas inventadas; nada toca la API ni archivos.

import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  computeStats,
  evaluate,
  type RegressionRow,
} from "./regression-compare.js";

function row(n: number, over: Partial<RegressionRow> = {}): RegressionRow {
  return {
    n,
    intent: "buscar_por_texto",
    verified: false,
    claims: [{ supported: true }],
    aiCalls: 2,
    elapsedMs: 4000,
    ...over,
  };
}

/** 100 preguntas: `verifiedCount` verificadas, el resto no. */
function run(
  verifiedCount: number,
  over: (n: number) => Partial<RegressionRow> = () => ({})
): RegressionRow[] {
  return Array.from({ length: 100 }, (_, i) =>
    row(i + 1, { verified: i < verifiedCount, ...over(i + 1) })
  );
}

describe("computeStats", () => {
  it("cuenta como exitosa una pregunta con error transitorio y luego respuesta", () => {
    const stats = computeStats([row(1, { error: "timeout" }), row(1), row(2)]);
    expect(stats.answered).toBe(2);
    expect(stats.hardErrors).toBe(0);
  });

  it("una pregunta que solo tiene error es un error duro", () => {
    const stats = computeStats([row(1, { error: "boom" }), row(2)]);
    expect(stats.answered).toBe(1);
    expect(stats.hardErrors).toBe(1);
  });

  it("detecta respuestas exitosas repetidas (idempotencia rota)", () => {
    expect(computeStats([row(1), row(1), row(2)]).duplicateSuccesses).toBe(1);
  });

  it("calcula tasas de verificadas, sin respaldo y no soportadas", () => {
    const stats = computeStats([
      row(1, { verified: true, claims: [{ supported: true }, { supported: false }] }),
      row(2, { intent: "no_soportado", claims: [] }),
    ]);
    expect(stats.verifiedRate).toBe(0.5);
    expect(stats.unsupportedClaimRate).toBeCloseTo(0.5);
    expect(stats.noSoportadoRate).toBe(0.5);
  });

  it("sin filas no divide por cero", () => {
    const stats = computeStats([]);
    expect(stats.answered).toBe(0);
    expect(stats.verifiedRate).toBe(0);
  });
});

describe("evaluate", () => {
  const baseline = computeStats(run(20));

  it("un candidato idéntico a la línea base pasa todo", () => {
    expect(evaluate(baseline, computeStats(run(20))).every((v) => v.pass)).toBe(true);
  });

  it("la caída de verificadas se tolera hasta el umbral y no más", () => {
    const limite = 20 - THRESHOLDS.maxVerifiedDropPoints;
    const verified = (c: number) =>
      evaluate(baseline, computeStats(run(c))).find((v) => v.name === "respuestas verificadas")!;
    expect(verified(limite).pass).toBe(true);
    expect(verified(limite - 1).pass).toBe(false);
  });

  it("más de dos errores duros fallan", () => {
    const withErrors = (k: number) =>
      computeStats(run(20, (n) => (n <= k ? { error: "x" } : {}))).hardErrors;
    expect(withErrors(2)).toBe(2);
    const r = (k: number) =>
      evaluate(baseline, computeStats(run(20, (n) => (n <= k ? { error: "x" } : {})))).find(
        (v) => v.name === "errores duros"
      )!;
    expect(r(2).pass).toBe(true);
    expect(r(3).pass).toBe(false);
  });

  it("falla si las afirmaciones sin respaldo suben más que el umbral", () => {
    const peor = computeStats(
      run(20, () => ({ claims: [{ supported: false }, { supported: true }] }))
    );
    const v = evaluate(baseline, peor).find((x) => x.name === "afirmaciones sin respaldo")!;
    expect(v.pass).toBe(false);
  });

  it("falla si baja la coincidencia de intent con la línea base", () => {
    const otroIntent = computeStats(
      run(20, (n) => (n <= 40 ? { intent: "buscar_por_tema" } : {}))
    );
    const v = evaluate(baseline, otroIntent).find((x) => x.name.startsWith("coincidencia"))!;
    expect(v.pass).toBe(false); // 60% < 70%
  });

  it("falla si las respuestas exitosas se repiten", () => {
    const repetido = computeStats([...run(20), row(1)]);
    const v = evaluate(baseline, repetido).find((x) => x.name.startsWith("idempotencia"))!;
    expect(v.pass).toBe(false);
  });

  it("falla si quedan muchas preguntas sin responder", () => {
    const incompleto = computeStats(run(20).slice(0, 90));
    const v = evaluate(baseline, incompleto).find((x) => x.name === "preguntas respondidas")!;
    expect(v.pass).toBe(false);
  });
});
