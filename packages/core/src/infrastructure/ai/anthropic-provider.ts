// Única implementación de AIProvider que importa el SDK de Anthropic.
// Nada fuera de este archivo debería hacer `import Anthropic from
// "@anthropic-ai/sdk"` (docs/ARCHITECTURE.md, "IA desacoplada").

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../shared/config.js";
import type {
  CompletionOptions,
  DescribedAIProvider,
  EmbeddingOptions,
  ProviderInfo,
  TokenUsage,
} from "./provider.js";
import { ModelResponseTruncatedError } from "./provider.js";

/**
 * Sin razonamiento salvo que el caller pida otra cosa.
 *
 * En Sonnet 5 el razonamiento adaptativo está activado por defecto y sus
 * tokens se facturan como salida; omitir el parámetro no significa "sin
 * razonamiento" como en modelos anteriores. Fijarlo explícitamente hace
 * que el gasto sea una decisión visible y no un default heredado
 * (`rules/ai-cost.md`).
 */
const DEFAULT_THINKING: NonNullable<CompletionOptions["thinking"]> = "disabled";

/**
 * Con razonamiento adaptativo, `max_tokens` acota razonamiento Y respuesta
 * juntos, así que el default de 1024 alcanza para que el modelo piense y
 * deje la respuesta truncada — con la llamada ya facturada. Se exige
 * margen explícito en vez de confiar en que el caller lo recuerde.
 */
const MIN_MAX_TOKENS_FOR_ADAPTIVE_THINKING = 4096;

// Se movió a provider.ts (es común a todos los motores); se reexporta para no
// romper a quien ya la importaba desde acá.
export { ModelResponseTruncatedError };

export class AnthropicProvider implements DescribedAIProvider {
  readonly info: ProviderInfo = {
    name: "anthropic-api",
    capabilities: {
      structuredOutput: "native",
      usage: "exact",
      billing: "api",
      dataLeavesMachine: true,
      supportsThinking: true,
    },
  };

  private readonly client: Anthropic;

  constructor(apiKey: string = config.anthropicApiKey) {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY no está definida. Ver .env.example."
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
    const model =
      opts.tier === "cheap" ? config.aiModelCheap : config.aiModelDefault;

    // `temperature` ya no se envía nunca. Sonnet 5 rechaza con HTTP 400
    // cualquier valor no-default de temperature/top_p/top_k, así que
    // reenviarlo (como se hacía antes) habría hecho fallar Event
    // Detection en su primera llamada real. La forma soportada de guiar
    // el comportamiento en estos modelos es el prompt, no el sampling.
    const thinking = opts.thinking ?? DEFAULT_THINKING;
    const maxTokens = opts.maxTokens ?? 1024;

    if (thinking === "adaptive" && maxTokens < MIN_MAX_TOKENS_FOR_ADAPTIVE_THINKING) {
      throw new Error(
        `thinking: "adaptive" necesita maxTokens >= ${MIN_MAX_TOKENS_FOR_ADAPTIVE_THINKING} ` +
          `(recibido ${maxTokens}): max_tokens acota razonamiento y respuesta juntos, ` +
          "así que con poco margen el modelo razona y devuelve una respuesta truncada, ya facturada."
      );
    }

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      // El parámetro se manda SOLO cuando cambia el comportamiento por
      // defecto del modelo, es decir para pedir razonamiento. Apagarlo no
      // se manda: los modelos del tier "cheap" (Haiku 4.5) ya vienen sin
      // razonamiento, y mandarles un parámetro que no necesitan sería
      // meter una variable nueva no verificada en el pipeline de mayor
      // volumen (Entity Detection, miles de mensajes) a cambio de nada.
      // El único modelo cuyo default hay que corregir es Sonnet 5, que
      // razona salvo que se le diga lo contrario.
      ...(thinking === "adaptive"
        ? { thinking: { type: "adaptive" } satisfies Anthropic.ThinkingConfigAdaptive }
        : model === config.aiModelDefault
          ? { thinking: { type: "disabled" } satisfies Anthropic.ThinkingConfigDisabled }
          : {}),
    };

    // opts.jsonSchema prometía "forzar JSON válido" en la interfaz
    // (provider.ts) pero esta implementación lo ignoraba — el modelo
    // solo recibía la instrucción por prompt, sin garantía real. Se
    // fuerza acá con tool-use (un "tool" sintético cuyo input_schema es
    // el jsonSchema pedido + tool_choice obligado a usarlo): el SDK
    // devuelve `tool_use.input` ya parseado y validado contra el schema
    // por Anthropic, no texto libre que después hay que parsear a mano.
    if (opts.jsonSchema) {
      const response = await this.client.messages.create({
        ...request,
        tools: [
          {
            name: "respond_with_structured_output",
            description:
              "Devuelve la respuesta estructurada según el esquema JSON pedido.",
            input_schema: opts.jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "respond_with_structured_output" },
      });
      reportUsage(model, response.usage, opts.onUsage);

      // Truncamiento por max_tokens con tool-use NO se nota solo: Anthropic
      // devuelve un tool_use PARCIAL, así que `JSON.stringify(input)` da
      // JSON sintácticamente válido de un objeto incompleto. El parseo río
      // abajo falla después culpando al modelo ("no declara si la evidencia
      // era suficiente") cuando en realidad la respuesta se cortó a mitad
      // — diagnóstico equivocado sobre una llamada YA facturada. Detectado
      // en la regresión de 100 preguntas (docs/DECISIONS.md, 2026-08-04):
      // la pregunta con más evidencia (40 ítems) superó los 2048 tokens.
      if (response.stop_reason === "max_tokens") {
        throw new ModelResponseTruncatedError(
          `La respuesta del modelo se truncó al llegar a max_tokens (${maxTokens}) y quedó incompleta. ` +
            "Subí maxTokens en el caller o recortá el contexto que se le pasa; no es un error de formato del modelo."
        );
      }

      const toolBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      if (!toolBlock) {
        throw new Error(
          "La respuesta del modelo no incluyó el tool_use esperado (jsonSchema)."
        );
      }
      return JSON.stringify(toolBlock.input);
    }

    const response = await this.client.messages.create(request);
    reportUsage(model, response.usage, opts.onUsage);

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
      throw new Error("La respuesta del modelo no incluyó texto.");
    }
    return textBlock.text;
  }

  // Anthropic no ofrece un endpoint de embeddings propio (a diferencia
  // de completions). Elegir un proveedor de embeddings (ej. Voyage AI,
  // que Anthropic recomienda como partner, u otro) es una decisión
  // explícita de `rag-engineer` en plans/ — no
  // se improvisa aquí. Falla fuerte a propósito, no hay fallback
  // silencioso a un modelo no decidido.
  async embed(_text: string, _opts?: EmbeddingOptions): Promise<number[]> {
    throw new Error(
      "AnthropicProvider.embed() no está implementado: Anthropic no " +
        "expone un endpoint de embeddings. Ver plans/ " +
        "— rag-engineer debe elegir e implementar un proveedor de " +
        "embeddings dedicado (ej. VoyageEmbeddingProvider) antes de que " +
        "esta pieza se use."
    );
  }
}

function reportUsage(
  model: string,
  usage: Anthropic.Usage,
  onUsage: CompletionOptions["onUsage"]
): void {
  if (!onUsage) return;
  // La contabilidad de costos no puede tirar abajo la llamada que está
  // contabilizando: cuando esto corre, la respuesta YA se pagó. Perderla
  // por un bug en el acumulador significaría pagar de nuevo el mismo
  // mensaje en el reintento, justo lo que rules/ai-cost.md pide evitar.
  try {
    onUsage({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      billing: "api",
    } satisfies TokenUsage);
  } catch {
    // Deliberadamente silencioso: un total de costos incompleto es un
    // problema menor que perder una respuesta ya facturada.
  }
}
