// Motor de completions que ejecuta Claude Code en modo no interactivo
// (`claude -p`) y por lo tanto consume la cuota de la suscripción, no saldo de
// API (plans/). Es el ÚNICO archivo que conoce el formato de
// su salida.
//
// Contrato de errores, igual que el resto de los motores: un fallo del MOTOR
// (sin sesión, límite de uso, proceso que no arranca, tiempo agotado) se LANZA
// y corta la corrida; una respuesta mal formada se DEVUELVE como texto y la
// rechaza el parser por mensaje (SI-034).
//
// Forma de la salida verificada con Claude Code 2.1.x (fixtures en
// `fixtures/claude-code/`): un sobre JSON con `result`, `structured_output`
// (solo con --json-schema), `is_error`, `api_error_status`, `stop_reason`,
// `usage` y `modelUsage`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../shared/config.js";
import type {
  CompletionOptions,
  DescribedAIProvider,
  EmbeddingOptions,
  ProviderInfo,
  TokenUsage,
} from "./provider.js";
import { ModelResponseTruncatedError } from "./provider.js";
import {
  ProcessLaunchError,
  resolveClaudeCommand,
  spawnRunner,
  type ProcessRunner,
} from "./process-runner.js";

/** Se alcanzó el límite de uso de la suscripción. Cortar y reanudar más tarde. */
export class ClaudeCodeUsageLimitError extends Error {}

/** No hay sesión válida de Claude Code. */
export class ClaudeCodeAuthError extends Error {}

export interface ClaudeCodeOptions {
  modelCheap: string;
  modelDefault: string;
  /** Ruta explícita de claude.exe (CLAUDE_CLI_PATH); null = buscarlo. */
  cliPath: string | null;
  timeoutMs: number;
  /** Directorio neutro donde corre el CLI, para que no cargue ningún CLAUDE.md del proyecto. */
  workingDirectory: string;
}

/**
 * Prompt de sistema fijo y corto: reemplaza al de Claude Code, que de otro modo
 * añadiría instrucciones de agente de programación a cada llamada.
 */
const SYSTEM_PROMPT =
  "Eres un asistente de análisis de texto. Responde únicamente lo que pide el usuario. " +
  "Si se pide un esquema de salida, responde solo con ese esquema.";

/**
 * Variables que harían que `claude` facture por API en lugar de usar la
 * suscripción. El `.env` del proyecto las carga en `process.env`, así que sin
 * quitarlas del entorno del subproceso este motor gastaría saldo sin avisar.
 */
const ENV_VARS_THAT_SWITCH_TO_API_BILLING = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

function neutralWorkingDirectory(): string {
  const dir = path.join(os.tmpdir(), "cma-claude-code");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface Envelope {
  result?: unknown;
  structured_output?: unknown;
  is_error?: boolean;
  api_error_status?: number | null;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCodeProvider implements DescribedAIProvider {
  readonly info: ProviderInfo = {
    name: "claude-code",
    capabilities: {
      structuredOutput: "native",
      usage: "exact",
      billing: "subscription",
      dataLeavesMachine: true,
      supportsThinking: true,
    },
  };

  private readonly options: ClaudeCodeOptions;

  constructor(
    options: Partial<ClaudeCodeOptions> = {},
    private readonly run: ProcessRunner = spawnRunner,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.options = {
      modelCheap: options.modelCheap ?? config.claudeCodeModelCheap,
      modelDefault: options.modelDefault ?? config.claudeCodeModelDefault,
      cliPath: options.cliPath !== undefined ? options.cliPath : config.claudeCliPath,
      timeoutMs: options.timeoutMs ?? config.claudeCodeTimeoutMs,
      workingDirectory: options.workingDirectory ?? neutralWorkingDirectory(),
    };
  }

  async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
    const model = opts.tier === "cheap" ? this.options.modelCheap : this.options.modelDefault;

    // `maxTokens` no se puede imponer: el CLI no lo expone. El truncamiento se
    // detecta igual por `stop_reason` más abajo.
    const args = [
      "-p",
      "--output-format", "json",
      "--model", model,
      "--tools", "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--setting-sources", "",
      "--system-prompt", SYSTEM_PROMPT,
    ];
    // Haiku razona aunque no se le pida; `--effort low` lo reduce ~43% (medido).
    // No se puede apagar del todo, así que "disabled" significa "lo mínimo".
    if ((opts.thinking ?? "disabled") === "disabled") args.push("--effort", "low");
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));

    const result = await this.launch(args, prompt);

    let envelope: Envelope;
    try {
      envelope = JSON.parse(result.stdout) as Envelope;
    } catch {
      throw new Error(
        `Claude Code no devolvió JSON (código de salida ${result.exitCode}). ` +
          `stderr: ${result.stderr.slice(0, 300).trim() || "(vacío)"}`
      );
    }

    if (envelope.is_error || result.exitCode !== 0) {
      throw classifyEngineError(envelope, result.exitCode);
    }

    reportUsage(model, envelope, opts.onUsage);

    // Con tool-use el modelo puede cortarse a mitad y dejar un objeto parcial
    // que parece válido: se detecta igual que en AnthropicProvider.
    if (envelope.stop_reason === "max_tokens") {
      throw new ModelResponseTruncatedError(
        "La respuesta de Claude Code se truncó por el tope de tokens y quedó incompleta. " +
          "Recortá el contexto que se le pasa; no es un error de formato del modelo."
      );
    }

    if (opts.jsonSchema && envelope.structured_output !== undefined && envelope.structured_output !== null) {
      return JSON.stringify(envelope.structured_output);
    }
    // Sin salida estructurada (o sin esquema) se devuelve el texto tal cual: si
    // era un esquema y el modelo no lo cumplió, lo rechaza el parser por mensaje.
    return typeof envelope.result === "string" ? envelope.result : "";
  }

  /**
   * Chequeo de arranque con `claude auth status`, que no consume cuota. Falla
   * antes de la primera llamada si no hay sesión, y también si el CLI está
   * autenticado con una clave de API: cada llamada gastaría saldo en lugar de
   * usar la suscripción, que es justo lo que este motor existe para evitar.
   * Nunca incluye el correo ni otros datos de la cuenta en los errores.
   */
  async ensureReady(): Promise<void> {
    const result = await this.launch(["auth", "status", "--json"], "");

    let status: { loggedIn?: boolean; authMethod?: string };
    try {
      status = JSON.parse(result.stdout) as typeof status;
    } catch {
      throw new Error(
        `No pude leer \`claude auth status\` (código de salida ${result.exitCode}). ` +
          `stderr: ${result.stderr.slice(0, 200).trim() || "(vacío)"}`
      );
    }

    if (!status.loggedIn) {
      throw new ClaudeCodeAuthError(
        "Claude Code no tiene sesión iniciada: ejecutá `claude login` en una terminal."
      );
    }
    const method = String(status.authMethod ?? "");
    if (/api|console|key|token/i.test(method)) {
      throw new ClaudeCodeAuthError(
        `Claude Code está autenticado con "${method}", no con una suscripción: cada llamada ` +
          "consumiría saldo de API. Iniciá sesión con tu cuenta de suscripción (`claude login`) " +
          "o usá AI_PROVIDER=anthropic-api si eso es lo que querés."
      );
    }
  }

  // Claude Code no ofrece embeddings: ver EMBEDDING_PROVIDER.
  async embed(_text: string, _opts?: EmbeddingOptions): Promise<number[]> {
    throw new Error(
      "ClaudeCodeProvider.embed() no está implementado: Claude Code no genera embeddings. " +
        "Usá EMBEDDING_PROVIDER para elegir un motor de embeddings."
    );
  }

  private async launch(args: string[], prompt: string) {
    let command: string;
    try {
      command = resolveClaudeCommand(this.options.cliPath);
    } catch (error) {
      throw error instanceof ProcessLaunchError ? error : new Error(String(error));
    }

    const env: NodeJS.ProcessEnv = { ...this.env };
    for (const name of ENV_VARS_THAT_SWITCH_TO_API_BILLING) delete env[name];

    let result;
    try {
      result = await this.run({
        command,
        args,
        stdin: prompt,
        cwd: this.options.workingDirectory,
        env,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ProcessLaunchError && error.code === "ENOENT") {
        throw new ProcessLaunchError(
          `No se pudo lanzar Claude Code (${command}). Instalalo e iniciá sesión (\`claude login\`), ` +
            "definí CLAUDE_CLI_PATH, o usá AI_PROVIDER=anthropic-api.",
          "ENOENT"
        );
      }
      throw error;
    }

    if (result.timedOut) {
      throw new Error(
        `Claude Code no respondió en ${Math.round(this.options.timeoutMs / 1000)} s y se canceló la llamada.`
      );
    }
    return result;
  }
}

/** Traduce un sobre con error a un error de motor que dice qué hacer. */
function classifyEngineError(envelope: Envelope, exitCode: number | null): Error {
  const detail = typeof envelope.result === "string" ? envelope.result : "";
  const status = envelope.api_error_status ?? null;
  const prefix = `Claude Code devolvió un error${status ? ` (HTTP ${status})` : ""}`;

  if (/oauth|authenticat|log ?in|not logged|sesi[oó]n/i.test(detail)) {
    return new ClaudeCodeAuthError(
      `${prefix}: ${detail} — iniciá sesión con \`claude login\` en una terminal.`
    );
  }
  // La forma exacta del error por límite de uso NO está verificada (no se puede
  // provocar sin agotar la cuota): se detecta por estado 429 o por el texto.
  if (status === 429 || /usage limit|limit reached|rate limit|too many requests|quota/i.test(detail)) {
    return new ClaudeCodeUsageLimitError(
      `${prefix}: ${detail} — se alcanzó el límite de uso de la suscripción. ` +
        "El procesamiento es idempotente: reanudalo cuando se reinicie la cuota."
    );
  }
  return new Error(`${prefix} (código de salida ${exitCode}): ${detail || "(sin detalle)"}`);
}

function reportUsage(
  requestedModel: string,
  envelope: Envelope,
  onUsage: CompletionOptions["onUsage"]
): void {
  if (!onUsage) return;
  // La contabilidad no puede tirar abajo una llamada que ya consumió cuota
  // (mismo criterio que AnthropicProvider).
  try {
    const usage = envelope.usage ?? {};
    onUsage({
      // El modelo REAL que atendió la llamada (los alias `haiku`/`sonnet` apuntan
      // al más reciente y cambian), que es lo que se persiste (SI-019).
      model: Object.keys(envelope.modelUsage ?? {})[0] ?? requestedModel,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      billing: "subscription",
    } satisfies TokenUsage);
  } catch {
    // Deliberadamente silencioso.
  }
}
