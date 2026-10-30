// CLI de UC-014 (responder preguntas). Uso:
//   npm run ask -- "¿cuándo hablamos del teatro?"
//
// Llama a la API real de Anthropic (dos llamadas por pregunta: intent +
// respuesta), pero el gasto por pregunta es de céntimos, no comparable
// con las corridas de backlog. Aun así aplica rules/ai-cost.md: el costo
// observado se imprime al final.
//
// Si el intent resuelve a "buscar_por_tema" (Semantic Search), también
// llama a Voyage para embeber la pregunta — un texto corto, costo
// despreciable dentro del tier gratis (docs/DECISIONS.md). Sin
// EMBEDDING_MODEL/EMBEDDING_DIMENSIONS en .env, ese intent falla
// explícito en vez de responder sin evidencia; el resto de los intents
// no se ven afectados.
//
// Imprime el contenido de los mensajes que sustentan la respuesta. Eso es
// deliberado y es el pedido explícito que contempla CLAUDE.md regla 2:
// una respuesta sin su evidencia no sirve para nada en este sistema
// (SI-015/SI-037). Lo que no hace es volcar la conversación entera.

import { config } from "../../shared/config.js";
import { createAIProvider, createEmbeddingProvider } from "../../infrastructure/ai/factory.js";
import { formatRunHeader } from "../../infrastructure/ai/describe-provider.js";
import { UsageAccumulator } from "../../shared/ai-cost.js";
import { getActiveDomainProfile } from "../../shared/domain-profile-loader.js";
import { DrizzleConversationRepository } from "../../archive/infrastructure/conversation-repository.drizzle.js";
import { answerQuestion, type AnswerQuestionDeps } from "../use-cases/answer-question.js";
import { errorSummary } from "../../shared/error-summary.js";

async function main(): Promise<void> {
  const question = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!question) {
    throw new Error('Falta la pregunta. Uso: npm run ask -- "¿cuándo hablamos del teatro?"');
  }

  const conversationRepo = new DrizzleConversationRepository();
  const conversation = await conversationRepo.findConversation();
  if (!conversation) {
    throw new Error(
      "No hay ninguna Conversation importada todavía — corré `npm run sync` primero."
    );
  }

  const aiProvider = createAIProvider();
  // Embeddings solo si hay modelo y dimensión configurados: el resto de los intents no los necesitan.
  const embeddingProvider =
    config.embeddingModel && config.embeddingDimensions ? createEmbeddingProvider() : null;
  console.error(
    formatRunHeader({
      ai: aiProvider.info,
      profile: getActiveDomainProfile(),
      ...(embeddingProvider ? { embeddings: embeddingProvider.info } : {}),
    })
  );
  await aiProvider.ensureReady?.();

  const usage = new UsageAccumulator();
  const deps: AnswerQuestionDeps = {
    aiProvider,
    profile: getActiveDomainProfile(),
    onUsage: usage.record,
    ...(embeddingProvider && config.embeddingModel && config.embeddingDimensions
      ? {
          semanticSearch: {
            embeddingProvider,
            model: config.embeddingModel,
            dims: config.embeddingDimensions,
          },
        }
      : {}),
  };
  const result = await answerQuestion(deps, { conversationId: conversation.id, question });

  console.log(`\nPregunta: ${result.question}`);
  console.log(`Intent detectado: ${result.intent.intent}`);
  console.log(`\n${result.answer}\n`);

  if (!result.verified) {
    console.log(
      "AVISO: esta respuesta NO está completamente respaldada por la evidencia recuperada. No la trates como un hecho establecido.\n"
    );
  }
  if (result.evidenceTruncated) {
    console.log(
      "AVISO: la evidencia recuperada está recortada por el tope de resultados — hay más de lo que se muestra.\n"
    );
  }

  if (result.claims.length > 0) {
    console.log("Afirmaciones y su evidencia:");
    for (const claim of result.claims) {
      const marca = claim.supported ? "[respaldada]" : "[SIN RESPALDO]";
      console.log(`  ${marca} ${claim.statement}`);
      for (const id of claim.evidenceIds) console.log(`      - ${id}`);
    }
    console.log("");
  }

  if (result.context.length > 0) {
    console.log("Evidencia recuperada:");
    for (const item of result.context) {
      const fecha = item.sentAt.toISOString().slice(0, 16).replace("T", " ");
      console.log(`  [${item.index}] (${item.sourceType} ${item.sourceId}) ${fecha}`);
      console.log(`      ${item.text}`);
    }
    console.log("");
  }

  console.log(`Consumo de esta consulta:
${usage.report()}`);
}

main().catch((err) => {
  console.error(errorSummary(err));
  process.exitCode = 1;
});
