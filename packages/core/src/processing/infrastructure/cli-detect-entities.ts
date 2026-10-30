// CLI para correr Entity Detection (Pipeline 4) sobre la Conversation
// existente. Uso: `npm run process:entities`. Llama a la API real de
// Anthropic — rules/ai-cost.md aplica: costo aproximado + confirmación
// + doble verificación antes de correr contra el backlog real, nunca
// solo "correrlo y ver". Reejecutable (PL-003): solo procesa mensajes
// en METADATA_READY. Nunca imprime contenido de mensajes.
//
// Flags:
//   --limit <n>          procesa como mucho n mensajes y corta. Para
//                        validar en pequeño antes del backlog completo.
//   --ai-batch-size <n>  mensajes por llamada a la IA (default 25).

import { recordAudit } from "../../shared/audit.js";
import { createAIProvider } from "../../infrastructure/ai/factory.js";
import { formatRunHeader } from "../../infrastructure/ai/describe-provider.js";
import { UsageAccumulator } from "../../shared/ai-cost.js";
import { getActiveDomainProfile } from "../../shared/domain-profile-loader.js";
import { auditedRun } from "../../shared/run-audit.js";
import { DrizzleConversationRepository } from "../../archive/infrastructure/conversation-repository.drizzle.js";
import { detectEntitiesForConversation } from "../use-cases/detect-entities.js";
import { DrizzleProcessingRepository } from "./processing-repository.drizzle.js";
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

  const conversationRepo = new DrizzleConversationRepository();
  const conversation = await conversationRepo.findConversation();
  if (!conversation) {
    throw new Error(
      "No hay ninguna Conversation importada todavía — corré `npm run sync` primero."
    );
  }

  const aiProvider = createAIProvider();
  console.error(formatRunHeader({ ai: aiProvider.info, profile: getActiveDomainProfile() }));
  await aiProvider.ensureReady?.();

  const usage = new UsageAccumulator();
  const profile = getActiveDomainProfile();
  const result = await auditedRun(
    {
      actor: "cli-detect-entities",
      operation: "pipeline_run",
      conversationId: conversation.id,
      info: { ai: aiProvider.info, profile },
      record: recordAudit,
    },
    () =>
      detectEntitiesForConversation(
        {
          processingRepo: new DrizzleProcessingRepository(),
          aiProvider,
          audit: recordAudit,
          profile,
          onUsage: usage.record,
        },
        {
          conversationId: conversation.id,
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          ...(aiBatchSize !== undefined ? { aiBatchSize } : {}),
        }
      ),
    (r) => ({ stage: "entity_detection", ...r, cost: usage.summary() })
  );

  console.log(
    JSON.stringify(
      {
        conversationId: conversation.id,
        messagesProcessed: result.messagesProcessed,
        messagesFailed: result.messagesFailed,
        aiCalls: result.aiCalls,
        // Para copiar a docs/DECISIONS.md como costo REAL observado
        // (rules/ai-cost.md regla 5), no el estimado de antes de correr.
        cost: usage.summary(),
        estimatedUsdTotal: usage.totalUsd(),
        report: usage.report(),
      },
      null,
      2
    )
  );

  if (result.messagesFailed > 0) {
    console.warn(
      `${result.messagesFailed} mensaje(s) fallaron la validación de la respuesta de IA — revisar system_audit_log para el detalle. Quedan en METADATA_READY, reintentables en la próxima corrida.`
    );
  }
}

main().catch((err) => {
  console.error(errorSummary(err));
  process.exitCode = 1;
});
