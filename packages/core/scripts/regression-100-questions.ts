// Regresión manual de UC-014 sobre la conversación real: corre un banco
// de 100 preguntas contra `answerQuestion` (Pipeline 12 completo) para
// validar, antes de promover develop a main, que el sistema responde de
// verdad y no solo que compila.
//
// Vive FUERA de `npm run verify`, mismo criterio que smoke-ai.ts
// (rules/ai-cost.md regla 1): un push/PR nunca debe gastar saldo por sí
// solo. Se corre a mano con `npm run regression:questions`.
//
// --- rules/ai-cost.md regla 4 (idempotencia) ---
// Cada respuesta se persiste APENAS termina, en un JSONL de salida. Al
// arrancar, el script lee ese archivo y saltea las preguntas ya
// respondidas: una corrida interrumpida a mitad no vuelve a pagar las
// primeras N al reintentar. El costo acumulado también se recalcula
// desde el archivo, no desde cero.
//
// --- rules/agents-and-context.md + security-privacy.md ---
// Las respuestas citan evidencia REAL (mensajes de la conversación,
// potencialmente sobre terceros). Por eso:
//   * El detalle completo va a un ARCHIVO local bajo backups/ (ignorado
//     por git), nunca a stdout.
//   * stdout imprime solo agregados: conteos, distribución de intents,
//     latencias y costo. Ni una línea de `content` real.
// Es lo que permite revisar el resultado completo sin volcar el historial
// al contexto de Claude Code, que es una regla no negociable.

import "../src/shared/load-env.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/shared/config.js";
import { createAIProvider, createEmbeddingProvider } from "../src/infrastructure/ai/factory.js";
import { formatRunHeader } from "../src/infrastructure/ai/describe-provider.js";
import { UsageAccumulator } from "../src/shared/ai-cost.js";
import { DrizzleConversationRepository } from "../src/archive/infrastructure/conversation-repository.drizzle.js";
import { getActiveDomainProfile } from "../src/shared/domain-profile-loader.js";
import {
  answerQuestion,
  type AnswerQuestionDeps,
} from "../src/assistant/use-cases/answer-question.js";
import { REPO_ROOT } from "../src/shared/repo-paths.js";
import { QUESTIONS as DEFAULT_QUESTIONS, type BankQuestion } from "./regression-questions-bank.js";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const OUTPUT_DIR = path.join(REPO_ROOT, "backups");

// `--output <nombre>` escribe en backups/<nombre>.jsonl en vez del archivo por
// defecto. Existe para calificar un motor nuevo (plans/,
// sección 6): con el mismo archivo, las preguntas ya respondidas por el motor
// anterior se saltearían (regla 4 de rules/ai-cost.md) y no se mediría nada.
// Solo un nombre simple: nunca una ruta, para no escribir fuera de backups/.
const outputName = flagValue("--output") ?? "regression-100-questions";
if (!/^[\w.-]+$/.test(outputName)) {
  throw new Error("--output debe ser un nombre simple (letras, números, '.', '-', '_'), sin rutas.");
}
const OUTPUT_PATH = path.join(OUTPUT_DIR, `${outputName}.jsonl`);

/**
 * `--questions <archivo>` carga otro banco (módulo con `export const QUESTIONS`),
 * p. ej. uno local fuera de git con preguntas propias. Sin el flag se usa el banco
 * genérico del repo.
 */
async function loadQuestions(): Promise<BankQuestion[]> {
  const file = flagValue("--questions");
  if (!file) return DEFAULT_QUESTIONS;
  const module = (await import(pathToFileURL(path.resolve(file)).href)) as {
    QUESTIONS?: BankQuestion[];
  };
  if (!Array.isArray(module.QUESTIONS) || module.QUESTIONS.length === 0) {
    throw new Error(`${file} no exporta un QUESTIONS no vacío.`);
  }
  return module.QUESTIONS;
}

/** Una fila del JSONL de salida. `answer`/`evidence` traen texto real: nunca se imprimen. */
interface RecordedAnswer {
  n: number;
  question: string;
  intent: string;
  answer: string;
  verified: boolean;
  evidenceTruncated: boolean;
  contextItems: number;
  claims: Array<{ statement: string; supported: boolean; evidenceIds: string[] }>;
  /**
   * `sentAt` (ISO) es lo que permite volver al historial original y buscar
   * el mensaje por fecha — sin eso, un ítem de evidencia solo se puede
   * ubicar por su UUID, que no sirve para investigar en WhatsApp.
   * `windowMessages` cubre el caso de Semantic Search, donde un ítem
   * agrupa varios mensajes con fechas distintas y `sentAt` es solo la del
   * ancla.
   */
  evidence: Array<{
    index: number;
    sourceType: string;
    sourceId: string;
    sentAt: string;
    text: string;
    windowMessages?: Array<{ messageId: string; sentAt: string }>;
  }>;
  aiCalls: number;
  /**
   * Consumo de ESTA pregunta, desglosado por modelo. El acumulador global
   * solo da el total de la corrida, que no permite ver qué pregunta salió
   * cara: una con 40 ítems de evidencia cuesta ~10x una de 1 ítem, así
   * que prorratear el total daría un número que parece medido y no lo es.
   */
  usage: Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    estimatedUsd: number | null;
  }>;
  elapsedMs: number;
  error?: string;
}

/** rules/ai-cost.md regla 4: qué preguntas ya se pagaron en una corrida previa. */
async function loadAlreadyAnswered(): Promise<Set<number>> {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    const done = new Set<number>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as RecordedAnswer;
        // Una fila con error no cuenta como completada: se reintenta.
        if (typeof row.n === "number" && !row.error) done.add(row.n);
      } catch {
        // Línea corrupta (corrida cortada a mitad de escritura): se ignora
        // y esa pregunta se reintenta.
      }
    }
    return done;
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const questions = await loadQuestions();
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.indexOf("--limit");
  const limit =
    limitArg !== -1 ? Number(process.argv[limitArg + 1]) : questions.length;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit necesita un entero positivo.");
  }

  const alreadyAnswered = await loadAlreadyAnswered();
  const pending = questions.slice(0, limit).filter(
    (q) => !alreadyAnswered.has(q.n)
  );

  console.log(`Banco de preguntas: ${questions.length}`);
  console.log(`Ya respondidas en corridas previas: ${alreadyAnswered.size}`);
  console.log(`Pendientes en esta corrida: ${pending.length}`);
  console.log(`Salida (detalle completo, NO se imprime acá): ${OUTPUT_PATH}`);

  if (dryRun) {
    console.log("\n--dry-run: no se llama a ninguna API. Distribución esperada por categoría:");
    const byCategory = new Map<string, number>();
    for (const q of pending) {
      byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
    }
    for (const [category, count] of [...byCategory].sort()) {
      console.log(`  ${category}: ${count}`);
    }
    return;
  }

  if (pending.length === 0) {
    console.log("\nNada pendiente — todas las preguntas ya fueron respondidas.");
    return;
  }

  const conversationRepo = new DrizzleConversationRepository();
  const conversation = await conversationRepo.findConversation();
  if (!conversation) {
    throw new Error("No hay ninguna Conversation importada — corré `npm run sync` primero.");
  }

  if (!config.embeddingModel || !config.embeddingDimensions) {
    throw new Error(
      "EMBEDDING_MODEL / EMBEDDING_DIMENSIONS no están definidos: el intent buscar_por_tema fallaría. Ver .env.example."
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const aiProvider = createAIProvider();
  const embeddingProvider = createEmbeddingProvider();
  console.error(
    formatRunHeader({
      ai: aiProvider.info,
      embeddings: embeddingProvider.info,
      profile: getActiveDomainProfile(),
    })
  );
  await aiProvider.ensureReady?.();

  const usage = new UsageAccumulator();
  let aiCallsThisQuestion = 0;
  // Acumulador propio por pregunta, además del global: se reinicia en
  // cada iteración para poder guardar el costo individual en la fila.
  let perQuestionUsage = new UsageAccumulator();
  const deps: AnswerQuestionDeps = {
    aiProvider,
    profile: getActiveDomainProfile(),
    onUsage: (u) => {
      aiCallsThisQuestion += 1;
      usage.record(u);
      perQuestionUsage.record(u);
    },
    semanticSearch: {
      embeddingProvider,
      model: config.embeddingModel,
      dims: config.embeddingDimensions,
    },
  };

  const intentCounts = new Map<string, number>();
  let verifiedCount = 0;
  let noAnswerCount = 0;
  let errorCount = 0;
  let truncatedCount = 0;

  for (const [i, q] of pending.entries()) {
    aiCallsThisQuestion = 0;
    perQuestionUsage = new UsageAccumulator();
    const startedAt = Date.now();
    let row: RecordedAnswer;

    try {
      const result = await answerQuestion(deps, {
        conversationId: conversation.id,
        question: q.question,
      });

      row = {
        n: q.n,
        question: q.question,
        intent: result.intent.intent,
        answer: result.answer,
        verified: result.verified,
        evidenceTruncated: result.evidenceTruncated,
        contextItems: result.context.length,
        claims: result.claims.map((c) => ({
          statement: c.statement,
          supported: c.supported,
          evidenceIds: c.evidenceIds,
        })),
        evidence: result.context.map((c) => ({
          index: c.index,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          sentAt: c.sentAt.toISOString(),
          text: c.text,
          ...(c.windowMessages
            ? {
                windowMessages: c.windowMessages.map((m) => ({
                  messageId: m.messageId,
                  sentAt: m.sentAt.toISOString(),
                })),
              }
            : {}),
        })),
        aiCalls: aiCallsThisQuestion,
        usage: perQuestionUsage.summary(),
        elapsedMs: Date.now() - startedAt,
      };

      intentCounts.set(row.intent, (intentCounts.get(row.intent) ?? 0) + 1);
      if (row.verified) verifiedCount += 1;
      if (result.context.length === 0) noAnswerCount += 1;
      if (row.evidenceTruncated) truncatedCount += 1;
    } catch (err) {
      // SI-034 / docs/ERROR_HANDLING.md: una pregunta que falla no tumba
      // la corrida entera; se registra y se sigue. Al no marcarse como
      // completada, un reintento posterior la vuelve a tomar.
      errorCount += 1;
      row = {
        n: q.n,
        question: q.question,
        intent: "ERROR",
        answer: "",
        verified: false,
        evidenceTruncated: false,
        contextItems: 0,
        claims: [],
        evidence: [],
        aiCalls: aiCallsThisQuestion,
        // Una pregunta que falló igual consumió tokens: se registra para
        // que el costo del reintento no quede invisible.
        usage: perQuestionUsage.summary(),
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Persistir ANTES de seguir: es lo que hace la corrida reanudable.
    await appendFile(OUTPUT_PATH, `${JSON.stringify(row)}\n`, "utf8");

    // Progreso sin contenido real: número, intent y si quedó verificada.
    const marca = row.error ? "ERROR" : row.verified ? "verificada" : "sin respaldo";
    console.log(
      `  [${i + 1}/${pending.length}] #${q.n} (${q.category}) → intent=${row.intent}, ${marca}, ${row.contextItems} ítems, ${row.elapsedMs}ms`
    );
  }

  console.log("\n--- Resumen agregado (sin contenido de la conversación) ---");
  console.log(`Preguntas corridas en esta sesión: ${pending.length}`);
  console.log(`Respuestas verificadas: ${verifiedCount}`);
  console.log(`Sin evidencia recuperada ("no puedo responder"): ${noAnswerCount}`);
  console.log(`Con evidencia recortada por el tope: ${truncatedCount}`);
  console.log(`Errores: ${errorCount}`);
  console.log("\nDistribución de intents detectados:");
  for (const [intent, count] of [...intentCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${intent}: ${count}`);
  }

  console.log("\n--- Consumo real de esta corrida (rules/ai-cost.md regla 5) ---");
  console.log(JSON.stringify(usage.summary(), null, 2));
  console.log(usage.report());
  console.log(`\nDetalle completo (con evidencia real) en: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
