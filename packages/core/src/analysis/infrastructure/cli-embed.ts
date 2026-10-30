// CLI para correr Embedding Generation (Pipeline 10) sobre la
// Conversation existente. Uso: `npm run process:embeddings`. Llama a la
// API real de Voyage — rules/ai-cost.md aplica: costo aproximado +
// confirmación + doble verificación antes de correr contra el backlog
// real, nunca solo "correrlo y ver". Reejecutable (PL-003): solo procesa
// mensajes pendientes. Nunca imprime contenido de mensajes.
//
// Flags:
//   --limit <n>          procesa como mucho n mensajes y corta. Para
//                        validar en pequeño antes del backlog completo.
//   --ai-batch-size <n>  chunks por llamada a Voyage (default 64).

import { config } from "../../shared/config.js";
import { recordAudit } from "../../shared/audit.js";
import { createEmbeddingProvider } from "../../infrastructure/ai/factory.js";
import { formatRunHeader } from "../../infrastructure/ai/describe-provider.js";
import { auditedRun } from "../../shared/run-audit.js";
import { DrizzleConversationRepository } from "../../archive/infrastructure/conversation-repository.drizzle.js";
import { generateEmbeddingsForConversation } from "../embeddings.js";
import { DrizzleEmbeddingsRepository } from "./embeddings-repository.drizzle.js";
import { errorSummary } from "../../shared/error-summary.js";

function numericFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} necesita un entero positivo, recibido: "${raw ?? ""}".`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const maxMessages = numericFlag("--limit");
  const aiBatchSize = numericFlag("--ai-batch-size");

  if (!config.embeddingModel || !config.embeddingDimensions) {
    throw new Error(
      "EMBEDDING_MODEL / EMBEDDING_DIMENSIONS no están definidos. Ver .env.example y docs/DECISIONS.md."
    );
  }

  const conversationRepo = new DrizzleConversationRepository();
  const conversation = await conversationRepo.findConversation();
  if (!conversation) {
    throw new Error(
      "No hay ninguna Conversation importada todavía — corré `npm run sync` primero."
    );
  }

  const embeddingProvider = createEmbeddingProvider();
  console.error(formatRunHeader({ embeddings: embeddingProvider.info }));

  let totalTokens = 0;
  let embeddingCalls = 0;
  const embeddingModel = config.embeddingModel;
  const embeddingDimensions = config.embeddingDimensions;
  const result = await auditedRun(
    {
      actor: "cli-embed",
      operation: "pipeline_run",
      conversationId: conversation.id,
      info: { embeddings: embeddingProvider.info },
      record: recordAudit,
    },
    () =>
      generateEmbeddingsForConversation(
        {
          embeddingsRepo: new DrizzleEmbeddingsRepository(),
          embeddingProvider,
          audit: recordAudit,
          model: embeddingModel,
          dimensions: embeddingDimensions,
          onUsage: (usage) => {
            totalTokens += usage.totalTokens;
            embeddingCalls += 1;
          },
        },
        {
          conversationId: conversation.id,
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          ...(aiBatchSize !== undefined ? { aiBatchSize } : {}),
        }
      ),
    (r) => ({
      stage: "embedding_generation",
      model: embeddingModel,
      dimensions: embeddingDimensions,
      ...r,
      usage: { calls: embeddingCalls, totalTokens },
    })
  );

  console.log(
    JSON.stringify(
      {
        conversationId: conversation.id,
        model: config.embeddingModel,
        dimensions: config.embeddingDimensions,
        messagesProcessed: result.messagesProcessed,
        messagesFailed: result.messagesFailed,
        aiCalls: result.aiCalls,
        // Para copiar a docs/DECISIONS.md como costo REAL observado
        // (rules/ai-cost.md regla 5). Voyage cobra por tokens de entrada
        // únicamente (no hay tokens de "salida" en embeddings) — la
        // conversión a USD vive fuera de este CLI porque el precio por
        // token es política de facturación de Voyage, no del dominio.
        usage: { calls: embeddingCalls, totalTokens },
      },
      null,
      2
    )
  );

  if (result.messagesFailed > 0) {
    console.warn(
      `${result.messagesFailed} mensaje(s) fallaron la validación de la respuesta de Voyage — revisar system_audit_log para el detalle. Reintentables en la próxima corrida.`
    );
  }
}

main().catch((err) => {
  console.error(errorSummary(err));
  process.exitCode = 1;
});
