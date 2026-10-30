// Lanzador de procesos para los proveedores que ejecutan un CLI (hoy,
// `claude-code`). Es una función inyectable: los tests usan una falsa y nunca
// lanzan el CLI real ni consumen cuota (rules/ai-cost.md).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessRequest {
  command: string;
  args: string[];
  /** Se escribe por stdin: evita el límite de largo de la línea de comandos en Windows. */
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** El ejecutable no existe o no se pudo lanzar (distinto de "corrió y falló"). */
export class ProcessLaunchError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export const spawnRunner: ProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProcessLaunchError(error.message, error.code));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });

    // Un proceso que muere antes de leer stdin cierra la tubería: no es un
    // error nuestro, el código de salida ya lo cuenta.
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin);
  });

// --- Resolución del ejecutable de Claude Code ---------------------------------

export interface ResolveClaudeDeps {
  platform: NodeJS.Platform;
  /** Salida de `where claude` (una ruta por línea) en Windows. */
  whereClaude: () => string;
  exists: (file: string) => boolean;
}

const realDeps: ResolveClaudeDeps = {
  platform: process.platform,
  whereClaude: () => execFileSync("where", ["claude"], { encoding: "utf8" }),
  exists: (file) => fs.existsSync(file),
};

/**
 * En Windows `claude` es un acceso directo `claude.cmd` de npm que solo llama a
 * `bin/claude.exe`. Node no puede lanzar un `.cmd` sin shell (falla con EINVAL)
 * y pasar por `cmd` rompe el entrecomillado del esquema JSON, así que se
 * resuelve y ejecuta el `.exe` directamente. `cliPath` (CLAUDE_CLI_PATH) tiene
 * prioridad sobre cualquier búsqueda.
 */
export function resolveClaudeCommand(
  cliPath: string | null,
  deps: ResolveClaudeDeps = realDeps
): string {
  if (cliPath) return cliPath;
  if (deps.platform !== "win32") return "claude";

  let located = "";
  try {
    located = deps
      .whereClaude()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith("claude.cmd")) ?? "";
  } catch {
    // `where` falla si no hay ninguno en el PATH: se informa abajo.
  }
  if (!located) {
    throw new ProcessLaunchError(
      "No encontré Claude Code en el PATH. Instalalo e iniciá sesión (`claude login`), " +
        "definí CLAUDE_CLI_PATH con la ruta de claude.exe, o usá AI_PROVIDER=anthropic-api.",
      "ENOENT"
    );
  }

  // path.win32 explícito: esta rama solo aplica a Windows, y con `path` a
  // secas el test (que simula win32) fallaba al correr en Linux/CI.
  const exe = path.win32.join(
    path.win32.dirname(located),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe"
  );
  if (!deps.exists(exe)) {
    throw new ProcessLaunchError(
      `Encontré ${located} pero no ${exe}. Definí CLAUDE_CLI_PATH con la ruta de claude.exe.`,
      "ENOENT"
    );
  }
  return exe;
}
