// Única implementación de EmbeddingBatchProvider/AIProvider.embed() que
// habla con la API de Voyage. Nada fuera de este archivo debería llamar a
// `fetch("https://api.voyageai.com/...")` directamente (docs/ARCHITECTURE.md,
// "IA desacoplada" — mismo principio que aísla el SDK de Anthropic en
// anthropic-provider.ts). Voyage no tiene SDK oficial de Node en las
// dependencias del proyecto; se usa `fetch` nativo (Node >= 20, ver
// package.json "engines") en vez de sumar una dependencia nueva para una
// única llamada HTTP.
//
// Decisión de proveedor/modelo/dimensión: docs/DECISIONS.md, "Embeddings:
// proveedor, modelo, chunking, top-k y regeneración".

import { config } from "../../shared/config.js";
import type {
  AIProvider,
  CompletionOptions,
  DescribedEmbeddingProvider,
  EmbeddingBatchOptions,
  EmbeddingOptions,
  EmbeddingUsage,
  ProviderInfo,
} from "./provider.js";
import { EmbeddingValidationError } from "./provider.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

/**
 * Tope de textos por request. Voyage acepta lotes más grandes, pero no
 * hay beneficio real en arriesgar un 413/429 a la escala de este proyecto
 * (miles de mensajes): un tope conservador es más barato de corregir que un
 * lote que falla a mitad de una corrida real (`rules/ai-cost.md`).
 * Configurable por el caller si hiciera falta ajustarlo con datos reales.
 */
export const DEFAULT_MAX_BATCH_SIZE = 64;

/**
 * Tope de caracteres por texto, verificado ANTES de salir a la red.
 *
 * El smoke test contra la API real mostró que Voyage no rechaza un texto
 * que excede la ventana del modelo: lo TRUNCA en silencio y devuelve un
 * vector con pinta de válido (un texto de ~560k caracteres volvió como
 * 32k tokens facturados, sin error). Ese vector representa un pedazo del
 * texto, no el texto — o sea, contexto falso indetectable, justo lo que
 * `rules/dev-style.md` regla 4 manda no dejar pasar en silencio.
 *
 * 96.000 caracteres son ~24k tokens a 4 chars/token en español, cómodo
 * bajo los 32k de voyage-3-large. No es una restricción real para este
 * corpus (el mensaje más largo de la conversación son 1.939 caracteres,
 * el promedio 40, y un chunk son 3 mensajes) — es una red para que un
 * export futuro con algo patológico falle fuerte en vez de embeber basura.
 */
const MAX_CHARS_PER_TEXT = 96_000;

const MAX_RETRY_ATTEMPTS = 5;

/** Fallo transitorio del servidor (5xx) o de red: se despeja rápido. */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Backoff de 429, deliberadamente mucho más lento que el de 5xx.
 *
 * Un rate limit de Voyage se mide POR MINUTO (RPM/TPM), así que esperar
 * 500ms → 1s → 2s no despeja nada: se reintenta cuatro veces dentro de la
 * misma ventana y se agotan los intentos con la cuota igual de llena. El
 * smoke test contra la API real lo confirmó — una cuenta sin método de
 * pago queda en 3 RPM / 10K TPM y el backoff corto fallaba entero.
 *
 * Con 5s de base y 5 intentos la escalera es 5s → 10s → 20s → 40s (75s
 * acumulados), que cruza una ventana de un minuto completa. Importa
 * incluso con límites estándar: un 429 puntual a mitad del backlog cortaría
 * la corrida, y aunque los mensajes ya embebidos no se repagan
 * (`rules/ai-cost.md` regla 4), reanudar a mano es fricción evitable.
 */
const RATE_LIMIT_BASE_DELAY_MS = 5000;

/** Inyectable en tests para no esperar los backoffs reales. */
export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface VoyageEmbeddingObject {
  embedding: number[];
  index: number;
}

interface VoyageEmbeddingsResponse {
  data?: VoyageEmbeddingObject[];
  model?: string;
  usage?: { total_tokens?: number };
}

export class VoyageEmbeddingProvider implements AIProvider, DescribedEmbeddingProvider {
  readonly info: ProviderInfo = {
    name: "voyage",
    capabilities: {
      structuredOutput: "native",
      usage: "exact",
      // Dentro del tier gratuito no se factura, pero el recurso que se
      // consume es la cuota de una API externa, no la máquina local.
      billing: "api",
      dataLeavesMachine: true,
      supportsThinking: false,
    },
  };

  constructor(
    private readonly apiKey: string = config.voyageApiKey,
    private readonly sleep: Sleep = defaultSleep,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!apiKey) {
      throw new Error("VOYAGE_API_KEY no está definida. Ver .env.example.");
    }
  }

  async embedBatch(texts: string[], opts: EmbeddingBatchOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > DEFAULT_MAX_BATCH_SIZE) {
      throw new Error(
        `embedBatch recibió ${texts.length} textos, más que el tope de ${DEFAULT_MAX_BATCH_SIZE} — trocear antes de llamar.`
      );
    }

    // EmbeddingValidationError y no Error genérico: es un problema de ESTE
    // texto, aislable por mensaje en el caller (SI-034), no sistémico.
    const tooLong = texts.findIndex((t) => t.length > MAX_CHARS_PER_TEXT);
    if (tooLong !== -1) {
      throw new EmbeddingValidationError(
        `El texto de índice ${tooLong} tiene ${texts[tooLong]?.length} caracteres, ` +
          `sobre el tope de ${MAX_CHARS_PER_TEXT}. Voyage lo truncaría en silencio ` +
          `y devolvería un vector que no representa el texto completo.`
      );
    }

    const response = await this.requestWithRetry(texts, opts);
    return this.validateAndOrder(response, texts.length, opts);
  }

  /**
   * Satisface AIProvider.embed() (single-text). El pipeline real
   * (`src/analysis/embeddings.ts`, Semantic Search) usa `embedBatch`
   * directamente para poder elegir `inputType`; este método existe solo
   * para cumplir la interfaz genérica y por eso asume "document" — quien
   * necesite "query" debe llamar a `embedBatch` con el valor explícito.
   */
  async embed(text: string, opts?: EmbeddingOptions): Promise<number[]> {
    const model = opts?.model ?? requireEmbeddingModel();
    const dimensions = requireEmbeddingDimensions();
    const [vector] = await this.embedBatch([text], {
      model,
      dimensions,
      inputType: "document",
    });
    if (!vector) throw new EmbeddingValidationError("Voyage no devolvió ningún vector.");
    return vector;
  }

  // Voyage es exclusivamente un proveedor de embeddings — no expone
  // completions. Falla fuerte a propósito, simétrico al stub inverso de
  // AnthropicProvider.embed().
  async complete(_prompt: string, _opts?: CompletionOptions): Promise<string> {
    throw new Error(
      "VoyageEmbeddingProvider.complete() no está implementado: Voyage es " +
        "un proveedor de embeddings exclusivamente. Usar AnthropicProvider " +
        "para completions."
    );
  }

  private async requestWithRetry(
    texts: string[],
    opts: EmbeddingBatchOptions
  ): Promise<VoyageEmbeddingsResponse> {
    let lastError: Error = new Error("VoyageEmbeddingProvider: fallo desconocido.");

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      let httpResponse: Response;
      try {
        httpResponse = await this.fetchImpl(VOYAGE_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model: opts.model,
            input_type: opts.inputType,
            output_dimension: opts.dimensions,
          }),
        });
      } catch (err) {
        // Error de red (docs/ERROR_HANDLING.md, "Error del Modelo de IA":
        // timeout) — reintentable.
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.backoffBeforeRetry(attempt, null, RETRY_BASE_DELAY_MS);
        continue;
      }

      if (httpResponse.ok) {
        const body = (await httpResponse.json()) as VoyageEmbeddingsResponse;
        if (opts.onUsage) {
          reportEmbeddingUsage(body, opts.model, opts.onUsage);
        }
        return body;
      }

      // Credencial inválida: error sistémico y no transitorio, no tiene
      // sentido reintentar (mismo criterio que detectEntitiesForConversation
      // ante un fallo de saldo/credencial: se propaga de inmediato).
      if (httpResponse.status === 401 || httpResponse.status === 403) {
        const bodyText = await safeReadText(httpResponse);
        throw new Error(
          `Voyage rechazó la credencial (HTTP ${httpResponse.status}). ` +
            `Revisar VOYAGE_API_KEY. ${bodyText}`.trim()
        );
      }

      // Rate limit o error transitorio del servidor: reintentable, pero
      // con esperas de orden distinto (ver RATE_LIMIT_BASE_DELAY_MS).
      if (httpResponse.status === 429 || httpResponse.status >= 500) {
        const retryAfterHeader = httpResponse.headers.get("retry-after");
        const bodyText = await safeReadText(httpResponse);
        lastError = new Error(
          `Voyage respondió HTTP ${httpResponse.status} (intento ${attempt}/${MAX_RETRY_ATTEMPTS}). ${bodyText}`.trim()
        );
        const baseDelay =
          httpResponse.status === 429 ? RATE_LIMIT_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
        await this.backoffBeforeRetry(attempt, retryAfterHeader, baseDelay);
        continue;
      }

      // Cualquier otro 4xx (ej. 400 por texto demasiado largo) es un
      // error de validación de ESTE lote, no sistémico — no se reintenta,
      // se aísla en el caller (docs/ERROR_HANDLING.md, "Error de Validación").
      const bodyText = await safeReadText(httpResponse);
      throw new EmbeddingValidationError(
        `Voyage respondió HTTP ${httpResponse.status}: ${bodyText}`.trim()
      );
    }

    throw new Error(
      `Voyage: agotados ${MAX_RETRY_ATTEMPTS} intentos sin éxito. Último error: ${lastError.message}`
    );
  }

  private async backoffBeforeRetry(
    attempt: number,
    retryAfterHeader: string | null,
    baseDelayMs: number
  ): Promise<void> {
    // Tras el último intento ya no queda nada que esperar: dormir acá solo
    // retrasaría el error final (hasta 80s con el backoff de 429).
    if (attempt >= MAX_RETRY_ATTEMPTS) return;

    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const delay = Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : baseDelayMs * 2 ** (attempt - 1);
    await this.sleep(delay);
  }

  private validateAndOrder(
    response: VoyageEmbeddingsResponse,
    expectedCount: number,
    opts: EmbeddingBatchOptions
  ): number[][] {
    if (!Array.isArray(response.data)) {
      throw new EmbeddingValidationError(
        "La respuesta de Voyage no tiene un array `data` — forma inesperada."
      );
    }
    if (response.data.length !== expectedCount) {
      throw new EmbeddingValidationError(
        `Voyage devolvió ${response.data.length} vectores para ${expectedCount} textos pedidos.`
      );
    }

    // Se ordena por `index` en vez de confiar en el orden de llegada: la
    // API documenta `index` justamente para permitir reordenar, y confiar
    // en el orden crudo sin usarlo dejaría la atribución texto→vector
    // rota en silencio si algún día no coincidiera.
    const byIndex = new Map(response.data.map((item) => [item.index, item]));
    const ordered: number[][] = [];
    for (let i = 0; i < expectedCount; i += 1) {
      const item = byIndex.get(i);
      if (!item) {
        throw new EmbeddingValidationError(
          `Voyage no devolvió el vector de índice ${i} dentro del lote.`
        );
      }
      if (!Array.isArray(item.embedding) || item.embedding.length !== opts.dimensions) {
        throw new EmbeddingValidationError(
          `El vector de índice ${i} tiene dimensión ${item.embedding?.length ?? "desconocida"}, esperada ${opts.dimensions}.`
        );
      }
      ordered.push(item.embedding);
    }
    return ordered;
  }
}

function reportEmbeddingUsage(
  body: VoyageEmbeddingsResponse,
  requestedModel: string,
  onUsage: (usage: EmbeddingUsage) => void
): void {
  // Igual criterio que reportUsage() en anthropic-provider.ts: la
  // respuesta ya se pagó, un bug en la contabilidad no puede tirarla abajo.
  try {
    onUsage({
      model: body.model ?? requestedModel,
      totalTokens: body.usage?.total_tokens ?? 0,
    });
  } catch {
    // Deliberadamente silencioso — ver anthropic-provider.ts.
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function requireEmbeddingModel(): string {
  if (!config.embeddingModel) {
    throw new Error(
      "EMBEDDING_MODEL no está definido. Ver .env.example / docs/DECISIONS.md."
    );
  }
  return config.embeddingModel;
}

function requireEmbeddingDimensions(): number {
  if (!config.embeddingDimensions) {
    throw new Error(
      "EMBEDDING_DIMENSIONS no está definido. Ver .env.example / docs/DECISIONS.md."
    );
  }
  return config.embeddingDimensions;
}
