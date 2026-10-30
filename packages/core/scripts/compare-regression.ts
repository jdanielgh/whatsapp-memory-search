// Compara dos corridas del banco de regresión (regression-100-questions.ts) y
// decide si un motor candidato pasa la calificación (plans/,
// sección 6). Solo imprime AGREGADOS: nunca respuestas, preguntas ni evidencia
// (rules/security-privacy.md regla 1). La lógica y los umbrales viven en
// src/shared/regression-compare.ts.
//
// Uso:
//   npx tsx scripts/compare-regression.ts <linea-base> <candidato>
// Los nombres son los de backups/<nombre>.jsonl, sin extensión.

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/shared/repo-paths.js";
import {
  computeStats,
  describeStats,
  evaluate,
  type RegressionRow,
} from "../src/shared/regression-compare.js";

function readRows(name: string): RegressionRow[] {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Nombre inválido: ${name}`);
  const file = path.join(REPO_ROOT, "backups", `${name}.jsonl`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RegressionRow];
      } catch {
        return []; // línea cortada por una corrida interrumpida
      }
    });
}

const [baselineName, candidateName] = process.argv.slice(2);
if (!baselineName || !candidateName) {
  console.error("Uso: npx tsx scripts/compare-regression.ts <linea-base> <candidato>");
  process.exit(2);
}

const baseline = computeStats(readRows(baselineName));
const candidate = computeStats(readRows(candidateName));

console.log(`Línea base (${baselineName}): ${describeStats(baseline)}`);
console.log(`Candidato  (${candidateName}): ${describeStats(candidate)}\n`);

const verdicts = evaluate(baseline, candidate);
for (const v of verdicts) console.log(`${v.pass ? "PASA " : "FALLA"}  ${v.name}: ${v.detail}`);

const ok = verdicts.every((v) => v.pass);
console.log(
  `\n${ok ? "El motor candidato PASA la calificación." : "El motor candidato NO pasa la calificación: no cambiar el default."}`
);
process.exitCode = ok ? 0 : 1;
