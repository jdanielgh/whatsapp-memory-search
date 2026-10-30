// CLI para correr Event Detection + Case Resolution (Pipelines 5 y 6)
// sobre la Conversation existente. Uso: `npm run process:events`.
//
// Llama a la API real de Anthropic con el tier "default" (Sonnet), el
// más caro de los dos que usa el sistema — rules/ai-cost.md aplica:
// costo aproximado + confirmación + doble verificación antes de correr
// contra el backlog real. Reejecutable (PL-003): solo procesa mensajes
// en ENTITY_READY. Nunca imprime contenido de mensajes.
//
// Flags:
//   --limit <n>        procesa como mucho n mensajes y corta. Pensado
//                      para validar la calidad de la clasificación sobre
//                      un subconjunto antes de lanzar el backlog.
//   --window-size <n>  mensajes por ventana de análisis (default 20).
//   --thinking         activa el razonamiento del modelo. Mejora la
//                      clasificación y encarece la corrida; usar sobre
//                      subconjuntos, no sobre el backlog completo.

import { recordAudit } from "../../shared/audit.js";
import { createAIProvider } from "../../infrastructure/ai/factory.js";
import { formatRunHeader } from "../../infrastructure/ai/describe-provider.js";
import { UsageAccumulator } from "../../shared/ai-cost.js";
import { getActiveDomainProfile } from "../../shared/domain-profile-loader.js";
import { auditedRun } from "../../shared/run-audit.js";
import { DrizzleConversationRepository } from "../../archive/infrastructure/conversation-repository.drizzle.js";
import { detectEventsForConversation } from "../use-cases/detect-events.js";
import { DrizzleCaseRepository } from "./case-repository.drizzle.js";

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
  const windowSize = numericFlag("--window-size");
  const thinking = process.argv.includes("--thinking") ? "adaptive" : undefined;

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
      actor: "cli-detect-events",
      operation: "pipeline_run",
      conversationId: conversation.id,
      info: { ai: aiProvider.info, profile },
      record: recordAudit,
    },
    () =>
      detectEventsForConversation(
        {
          caseRepo: new DrizzleCaseRepository(),
          aiProvider,
          audit: recordAudit,
          profile,
          onUsage: usage.record,
        },
        {
          conversationId: conversation.id,
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          ...(windowSize !== undefined ? { windowSize } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
        }
      ),
    (r) => ({ stage: "event_detection", ...r, cost: usage.summary() })
  );

  console.log(
    JSON.stringify(
      {
        conversationId: conversation.id,
        messagesProcessed: result.messagesProcessed,
        messagesFailed: result.messagesFailed,
        eventsDetected: result.eventsDetected,
        casesCreated: result.casesCreated,
        aiCalls: result.aiCalls,
        // Para copiar a docs/DECISIONS.md como costo REAL observado
        // (rules/ai-cost.md regla 5).
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
      `${result.messagesFailed} mensaje(s) quedaron sin procesar porque su ventana devolvió una respuesta inválida — revisar system_audit_log. Siguen en ENTITY_READY, reintentables en la próxima corrida.`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
