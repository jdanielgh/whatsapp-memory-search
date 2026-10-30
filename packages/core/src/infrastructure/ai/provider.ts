// Abstracción de IA (docs/ARCHITECTURE.md, "IA desacoplada"). Ningún módulo
// de dominio importa el SDK de Anthropic directamente — solo
// `anthropic-provider.ts` lo hace. Esto es lo que permite cambiar de
// modelo/proveedor sin tocar el dominio (SI-046).

/**
 * Tokens consumidos por una llamada real. Existe para poder registrar el
 * costo REAL observado en `docs/DECISIONS.md` después de cada corrida
 * (`rules/ai-cost.md`, regla 5) en vez de solo el estimado — sin esto, la
 * única forma de saber cuánto costó una corrida es mirar la consola de
 * Anthropic a mano.
 *
 * Deliberadamente en tokens y no en USD: el precio por token es política
 * de facturación de Anthropic (y cambia — Sonnet 5 tiene precio
 * introductorio hasta 2026-08-31), no algo que el dominio deba conocer.
 * La conversión a dinero vive en el CLI que reporta.
 */
export interface TokenUsage {
  /**
   * Modelo que efectivamente atendió la llamada. Lo reporta el proveedor
   * y no el caller porque el caller elige un `tier`, no un modelo — sin
   * esto no se puede convertir tokens a USD (Haiku y Sonnet tienen
   * precios distintos) ni auditar qué modelo produjo qué.
   */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens leídos de caché de prompt (se facturan ~0.1x). 0 si no hubo caché. */
  cacheReadInputTokens: number;
  /**
   * Qué recurso consumió la llamada: saldo de API, cuota de suscripción o
   * máquina local (plans/). Solo `"api"` se convierte a USD;
   * el resto se reporta en llamadas y tokens. Ausente = "api", que es lo que
   * asumía el sistema antes de existir varios motores.
   */
  billing?: "api" | "subscription" | "local";
}

export interface CompletionOptions {
  /**
   * "cheap" usa AI_MODEL_CHEAP (Haiku); "default" usa AI_MODEL_DEFAULT
   * (Sonnet).
   *
   * Decisión de rag-engineer (docs/DECISIONS.md, "Modelo de IA para
   * Entity/Event Detection", plans/):
   * - Entity Detection (UC-006, `message_entities`): "cheap". Extracción
   *   estructurada de campos objetivos (persona/lugar/fecha/hora/
   *   institución/actividad/dinero — docs/DOMAIN_MODEL.md, ubiquitous
   *   language; docs/PIPELINES.md y docs/USE_CASES.md usan ejemplos
   *   ilustrativos distintos, no autoritativos), salida forzada a JSON,
   *   error barato de corregir (SI-030: todo Message se puede
   *   reprocesar) y de alto volumen (corre por mensaje).
   * - Event Detection (UC-007, `Event`+`Analysis`+`Observation`):
   *   "default". Clasificación interpretativa (propuesta/aceptación/
   *   rechazo/cambio_horario/discusión/acuerdo/cancelación/actividad)
   *   que alimenta Case Resolution e Insights, sobre una conversación que
   *   podría usarse como evidencia
   *   (rules/security-privacy.md regla 7) — prioriza calidad sobre
   *   costo.
   */
  tier?: "cheap" | "default";
  maxTokens?: number;
  /** Fuerza al modelo a responder JSON válido, cuando el proveedor lo soporta. */
  jsonSchema?: unknown;
  /**
   * Razonamiento extendido del modelo.
   *
   * Existe como opción explícita porque en Sonnet 5 el razonamiento
   * adaptativo viene **activado por defecto** (a diferencia de modelos
   * anteriores, donde omitir el parámetro significaba "sin
   * razonamiento"), y esos tokens se facturan como salida — la banda
   * cara. Sobre un backlog de miles de mensajes la diferencia no es
   * marginal, así que dejarlo implícito sería gastar saldo real sin
   * decidirlo (`rules/ai-cost.md`).
   *
   * - "disabled": sin razonamiento. Default de este proyecto.
   * - "adaptive": el modelo decide cuánto razonar. Más caro, y solo se
   *   justifica donde la calidad de la interpretación importe más que el
   *   costo (candidato real: Event Detection — ver la nota de `tier`).
   *
   * `maxTokens` acota razonamiento + respuesta juntos: subirlo a
   * "adaptive" sin dar margen trunca la respuesta a mitad.
   */
  thinking?: "disabled" | "adaptive";
  /**
   * Se invoca con los tokens consumidos por esta llamada. Opcional: los
   * fakes de los tests simplemente no lo llaman, y quien no lleve cuenta
   * de costos no lo pasa.
   */
  onUsage?: (usage: TokenUsage) => void;
}

/**
 * La respuesta se cortó por el tope de tokens y quedó incompleta. Se
 * distingue de un error de formato porque la acción correctiva es distinta
 * (subir el tope o recortar el contexto, no tolerar otra forma de JSON) y
 * porque el mensaje genérico de parseo culpaba al modelo por algo que no
 * hizo. Es común a todos los motores, por eso vive acá y no en uno solo.
 */
export class ModelResponseTruncatedError extends Error {}

export interface EmbeddingOptions {
  model?: string;
}

export interface AIProvider {
  complete(prompt: string, opts?: CompletionOptions): Promise<string>;
  embed(text: string, opts?: EmbeddingOptions): Promise<number[]>;
}

// --- Capacidades declaradas (plans/) -----------------------
//
// Cada motor dice qué hace y a dónde van los datos, en vez de que el resto
// del sistema lo suponga. Se imprime en el encabezado de cada corrida.

export interface ProviderCapabilities {
  /**
   * "native": el motor fuerza el esquema JSON pedido. "prompt": se le pide
   * JSON en el prompt y se confía en los parsers tolerantes.
   */
  structuredOutput: "native" | "prompt";
  /** Si informa tokens consumidos: "exact", "estimated" o "none". */
  usage: "exact" | "estimated" | "none";
  /** Cómo se paga: saldo de API, cuota de suscripción o máquina local. */
  billing: "api" | "subscription" | "local";
  /** true si el contenido de los mensajes sale del equipo hacia un tercero. */
  dataLeavesMachine: boolean;
  supportsThinking: boolean;
}

export interface ProviderInfo {
  name: string;
  capabilities: ProviderCapabilities;
}

/** Un `AIProvider` que además declara qué es y qué capacidades tiene. */
export interface DescribedAIProvider extends AIProvider {
  readonly info: ProviderInfo;
  /**
   * Chequeo de arranque, opcional: falla ANTES de la primera llamada si el
   * motor no puede funcionar (sin sesión, ejecutable ausente, facturación
   * distinta de la esperada). Debe ser gratis: no puede consumir cuota ni saldo.
   */
  ensureReady?(): Promise<void>;
}

/** Un `EmbeddingBatchProvider` que además declara qué es y qué capacidades tiene. */
export interface DescribedEmbeddingProvider extends EmbeddingBatchProvider {
  readonly info: ProviderInfo;
}

// --- Embeddings en lote (Pipeline 10, docs/DECISIONS.md "Embeddings:
// proveedor, modelo, chunking, top-k y regeneración") --------------------
//
// `AIProvider.embed()` de arriba es texto-a-texto porque así se definió
// en la fase 01, antes de elegir proveedor de embeddings. Generar
// embeddings para miles de mensajes uno por uno multiplicaría por miles el
// overhead de red y el riesgo de rate limit (`docs/ERROR_HANDLING.md`,
// "Error del Modelo de IA"); el pipeline real (`src/analysis/embeddings.ts`)
// depende de esta interfaz más chica, no de `AIProvider` completo.
// `VoyageEmbeddingProvider` implementa ambas.

export interface EmbeddingUsage {
  model: string;
  totalTokens: number;
}

export interface EmbeddingBatchOptions {
  /** Sin default silencioso: viene de config.embeddingModel (docs/DECISIONS.md). */
  model: string;
  /** Dimensión de salida pedida (Matryoshka en voyage-3 y familia). Sin default silencioso: viene de config.embeddingDimensions. */
  dimensions: number;
  /**
   * Asimetría document/query: Voyage embebe distinto un texto que se va a
   * indexar ("document") de uno que se usa para buscar ("query"), y
   * mezclar los dos degrada el ranking sin que nada "falle" de forma
   * visible — por eso es obligatorio, no opcional con default. Generar
   * embeddings de Message usa "document"; Semantic Search (Q-SEM-01/02)
   * usa "query" al embeber la consulta del usuario.
   */
  inputType: "document" | "query";
  /** Igual patrón que CompletionOptions.onUsage: opcional, para costo real observado (rules/ai-cost.md regla 5). */
  onUsage?: (usage: EmbeddingUsage) => void;
}

/**
 * Fallo de VALIDACIÓN de la respuesta (forma inesperada, cantidad de
 * vectores distinta a la de textos pedidos, dimensión distinta a la
 * pedida) — se distingue de un fallo de RED/AUTENTICACIÓN/RATE LIMIT
 * (esos quedan como Error genérico) para que el caller pueda aislar el
 * primero por lote (SI-034, mismo criterio que
 * `parseEntityDetectionResponse` en Entity Detection) sin tratar un fallo
 * sistémico (sin saldo, credencial inválida) como si fuera un problema de
 * este lote nada más.
 */
export class EmbeddingValidationError extends Error {}

export interface EmbeddingBatchProvider {
  /** Un vector por texto de entrada, en el mismo orden. */
  embedBatch(texts: string[], opts: EmbeddingBatchOptions): Promise<number[][]>;
}
