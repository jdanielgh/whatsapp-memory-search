// Tests del proveedor `claude-code`. Nunca lanzan el CLI real ni consumen
// cuota de la suscripción (rules/ai-cost.md regla 1): el lanzador de procesos
// es un fake que devuelve sobres REALES capturados con texto inventado
// (fixtures/claude-code/).
//
// Lo que se verifica es lo que fallaría en silencio y costaría cuota o
// contexto falso: que no se cuele ANTHROPIC_API_KEY (pasaría a facturar por
// API), que el contrato de errores separe motor de formato, y que el sobre
// real se traduzca bien.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/config.js", () => ({
  config: {
    claudeCodeModelCheap: "haiku",
    claudeCodeModelDefault: "sonnet",
    claudeCliPath: "C:/fake/claude.exe",
    claudeCodeTimeoutMs: 1000,
  },
}));

const { ClaudeCodeProvider, ClaudeCodeUsageLimitError, ClaudeCodeAuthError } = await import(
  "./claude-code-provider.js"
);
const { ModelResponseTruncatedError } = await import("./provider.js");
const { ProcessLaunchError, resolveClaudeCommand } = await import("./process-runner.js");
const { parseEventDetectionResponse } = await import("../../knowledge/domain/event-detection.js");
const { GENERIC_PROFILE } = await import("../../shared/generic-profile.js");

import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(here, "fixtures/claude-code", name), "utf8"));
}

function fakeRunner(
  stdout: unknown,
  extra: Partial<ProcessResult> = {}
): { run: ProcessRunner; calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
        stderr: "",
        timedOut: false,
        ...extra,
      };
    },
  };
}

function provider(runner: ProcessRunner, env: NodeJS.ProcessEnv = {}) {
  return new ClaudeCodeProvider({ workingDirectory: "C:/neutro" }, runner, env);
}

/** Valor que sigue a un flag en los argumentos. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("ClaudeCodeProvider — invocación", () => {
  it("manda el prompt por stdin y no como argumento", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run).complete("mi prompt largo");
    expect(calls[0]?.stdin).toBe("mi prompt largo");
    expect(calls[0]?.args).not.toContain("mi prompt largo");
  });

  it("elige el modelo según el tier", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run).complete("x", { tier: "cheap" });
    await provider(run).complete("x", { tier: "default" });
    await provider(run).complete("x");
    expect(calls.map((c) => flagValue(c.args, "--model"))).toEqual(["haiku", "sonnet", "sonnet"]);
  });

  it("aísla la llamada: sin herramientas, sin settings, sin sesión", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run).complete("x");
    const args = calls[0]!.args;
    expect(args).toContain("-p");
    expect(flagValue(args, "--output-format")).toBe("json");
    expect(flagValue(args, "--tools")).toBe("");
    expect(flagValue(args, "--setting-sources")).toBe("");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--bare"); // --bare no lee la sesión de suscripción
  });

  it("corre en un directorio neutro para no cargar ningún CLAUDE.md", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run).complete("x");
    expect(calls[0]?.cwd).toBe("C:/neutro");
  });

  it("NO pasa ANTHROPIC_API_KEY al subproceso: facturaría por API en vez de usar la suscripción", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run, {
      ANTHROPIC_API_KEY: "sk-no-debe-llegar",
      ANTHROPIC_AUTH_TOKEN: "token-no-debe-llegar",
      PATH: "/usr/bin",
    }).complete("x");
    const env = calls[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("razonamiento: 'disabled' (o sin indicar) usa --effort low; 'adaptive' deja el esfuerzo por defecto", async () => {
    const { run, calls } = fakeRunner(fixture("success-plain-text.json"));
    await provider(run).complete("x");
    await provider(run).complete("x", { thinking: "disabled" });
    await provider(run).complete("x", { thinking: "adaptive" });
    expect(calls.map((c) => flagValue(c.args, "--effort"))).toEqual(["low", "low", undefined]);
  });

  it("pasa el esquema JSON solo cuando se pide salida estructurada", async () => {
    const { run, calls } = fakeRunner(fixture("success-structured-small.json"));
    const schema = { type: "object", properties: { type: { type: "string" } } };
    await provider(run).complete("x", { jsonSchema: schema });
    await provider(run).complete("x");
    expect(JSON.parse(flagValue(calls[0]!.args, "--json-schema")!)).toEqual(schema);
    expect(calls[1]!.args).not.toContain("--json-schema");
  });
});

describe("ClaudeCodeProvider — resultado", () => {
  it("con esquema devuelve structured_output como texto JSON", async () => {
    const { run } = fakeRunner(fixture("success-structured-small.json"));
    const raw = await provider(run).complete("x", { jsonSchema: { type: "object" } });
    expect(JSON.parse(raw)).toEqual(
      (fixture("success-structured-small.json") as { structured_output: unknown }).structured_output
    );
  });

  it("la salida de una ventana real de eventos pasa por el parser del dominio", async () => {
    const { run } = fakeRunner(fixture("success-structured-events.json"));
    const raw = await provider(run).complete("x", { jsonSchema: { type: "object" } });
    const events = parseEventDetectionResponse(
      raw,
      Array.from({ length: 20 }, (_, i) => i + 1),
      GENERIC_PROFILE
    );
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => e.messageIndices.length > 0)).toBe(true);
  });

  it("sin esquema devuelve el texto de result", async () => {
    const { run } = fakeRunner(fixture("success-plain-text.json"));
    expect(await provider(run).complete("x")).toBe("Azul");
  });

  it("con esquema pero sin structured_output devuelve el texto en vez de lanzar (lo rechaza el parser por mensaje)", async () => {
    const { run } = fakeRunner({ is_error: false, result: "no cumplí el esquema", stop_reason: "end_turn" });
    expect(await provider(run).complete("x", { jsonSchema: { type: "object" } })).toBe(
      "no cumplí el esquema"
    );
  });

  it("informa el modelo REAL (no el alias) y mapea los tokens", async () => {
    const { run } = fakeRunner(fixture("success-structured-events.json"));
    const onUsage = vi.fn();
    await provider(run).complete("x", { jsonSchema: { type: "object" }, onUsage });
    const envelope = fixture("success-structured-events.json") as {
      usage: { cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number; input_tokens: number };
      modelUsage: Record<string, unknown>;
    };
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]![0]).toEqual({
      model: Object.keys(envelope.modelUsage)[0],
      inputTokens: envelope.usage.input_tokens + envelope.usage.cache_creation_input_tokens,
      outputTokens: envelope.usage.output_tokens,
      cacheReadInputTokens: envelope.usage.cache_read_input_tokens,
      billing: "subscription",
    });
  });

  it("un fallo del contador de uso no tira la llamada ya consumida", async () => {
    const { run } = fakeRunner(fixture("success-plain-text.json"));
    const onUsage = vi.fn(() => {
      throw new Error("bug del acumulador");
    });
    await expect(provider(run).complete("x", { onUsage })).resolves.toBe("Azul");
  });

  it("una respuesta cortada por el tope de tokens se distingue de un error de formato", async () => {
    const { run } = fakeRunner({ is_error: false, result: "{", stop_reason: "max_tokens" });
    await expect(provider(run).complete("x")).rejects.toBeInstanceOf(ModelResponseTruncatedError);
  });
});

describe("ClaudeCodeProvider — errores del motor (cortan la corrida)", () => {
  it("traduce el sobre de error real (modelo inexistente) con estado HTTP y detalle", async () => {
    const { run } = fakeRunner(fixture("error-unknown-model.json"), { exitCode: 1 });
    await expect(provider(run).complete("x")).rejects.toThrow(/HTTP 404.*modelo/s);
  });

  it("una sesión expirada indica cómo iniciar sesión", async () => {
    const { run } = fakeRunner(
      {
        is_error: true,
        api_error_status: null,
        terminal_reason: "api_error",
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
      { exitCode: 1 }
    );
    const error = await provider(run)
      .complete("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeAuthError);
    expect((error as Error).message).toContain("claude login");
  });

  it("un límite de uso se distingue y recuerda que se puede reanudar", async () => {
    const { run } = fakeRunner(
      { is_error: true, api_error_status: 429, result: "Usage limit reached. Resets at 3pm." },
      { exitCode: 1 }
    );
    const error = await provider(run)
      .complete("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeUsageLimitError);
    expect((error as Error).message).toMatch(/idempotente|reanud/);
  });

  it("stdout que no es JSON es un fallo del motor, no una respuesta mal formada del modelo", async () => {
    const { run } = fakeRunner("esto no es json", { exitCode: 2, stderr: "boom" });
    await expect(provider(run).complete("x")).rejects.toThrow(/no devolvió JSON.*boom/s);
  });

  it("un tiempo agotado se informa y no se confunde con una respuesta vacía", async () => {
    const { run } = fakeRunner("", { exitCode: null, timedOut: true });
    await expect(provider(run).complete("x")).rejects.toThrow(/no respondió/);
  });

  it("si el ejecutable no existe, el error dice cómo resolverlo", async () => {
    const run: ProcessRunner = async () => {
      throw new ProcessLaunchError("spawn claude ENOENT", "ENOENT");
    };
    await expect(provider(run).complete("x")).rejects.toThrow(/claude login|CLAUDE_CLI_PATH|anthropic-api/);
  });

  it("embed no está soportado", async () => {
    const { run } = fakeRunner({});
    await expect(provider(run).embed("x")).rejects.toThrow(/no genera embeddings/);
  });
});

describe("ClaudeCodeProvider.ensureReady (chequeo de arranque, gratis)", () => {
  it("pasa con una sesión de suscripción y consulta `claude auth status`, no un modelo", async () => {
    const { run, calls } = fakeRunner(fixture("auth-status-subscription.json"));
    await expect(provider(run).ensureReady()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["auth", "status", "--json"]);
    // Sin ningún flag de modelo: no puede consumir cuota.
    expect(calls[0]?.args).not.toContain("--model");
  });

  it("falla con una instrucción si no hay sesión", async () => {
    const { run } = fakeRunner({ loggedIn: false }, { exitCode: 1 });
    const error = await provider(run).ensureReady().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeAuthError);
    expect((error as Error).message).toContain("claude login");
  });

  it("falla si el CLI está autenticado con una clave de API: gastaría saldo en lugar de cuota", async () => {
    const { run } = fakeRunner({ loggedIn: true, authMethod: "api_key" });
    const error = await provider(run).ensureReady().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeAuthError);
    expect((error as Error).message).toMatch(/saldo de API/);
  });

  it("no filtra el correo ni la organización en los errores", async () => {
    const { run } = fakeRunner({
      loggedIn: true,
      authMethod: "console",
      email: "alguien@ejemplo.com",
      orgName: "Organización Secreta",
    });
    const error = await provider(run).ensureReady().catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("alguien@ejemplo.com");
    expect((error as Error).message).not.toContain("Secreta");
  });

  it("una salida ilegible es un fallo del motor, no una sesión válida", async () => {
    const { run } = fakeRunner("no es json", { exitCode: 2, stderr: "boom" });
    await expect(provider(run).ensureReady()).rejects.toThrow(/No pude leer.*boom/s);
  });

  it("tampoco le pasa ANTHROPIC_API_KEY al chequeo", async () => {
    const { run, calls } = fakeRunner(fixture("auth-status-subscription.json"));
    await provider(run, { ANTHROPIC_API_KEY: "sk-no-debe-llegar" }).ensureReady();
    expect(calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("ClaudeCodeProvider.info", () => {
  it("declara suscripción y que los datos salen del equipo", () => {
    const { run } = fakeRunner({});
    expect(provider(run).info).toMatchObject({
      name: "claude-code",
      capabilities: { billing: "subscription", dataLeavesMachine: true, structuredOutput: "native" },
    });
  });
});

describe("resolveClaudeCommand", () => {
  const win = (where: string, exists = true) => ({
    platform: "win32" as const,
    whereClaude: () => where,
    exists: () => exists,
  });

  it("CLAUDE_CLI_PATH tiene prioridad", () => {
    expect(resolveClaudeCommand("D:/otro/claude.exe", win(""))).toBe("D:/otro/claude.exe");
  });

  it("fuera de Windows usa 'claude' del PATH", () => {
    expect(
      resolveClaudeCommand(null, { platform: "linux", whereClaude: () => "", exists: () => false })
    ).toBe("claude");
  });

  it("en Windows resuelve el claude.exe real detrás del acceso directo claude.cmd", () => {
    const where = "C:\\Users\\u\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\n";
    const exe = resolveClaudeCommand(null, win(where));
    expect(exe.replace(/\\/g, "/")).toMatch(/npm\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/);
  });

  it("si no hay claude.cmd en el PATH, falla con una instrucción", () => {
    expect(() => resolveClaudeCommand(null, win(""))).toThrow(/claude login|CLAUDE_CLI_PATH/);
  });

  it("si el acceso directo existe pero el .exe no, lo dice", () => {
    expect(() =>
      resolveClaudeCommand(null, win("C:\\npm\\claude.cmd\r\n", false))
    ).toThrow(/CLAUDE_CLI_PATH/);
  });
});
