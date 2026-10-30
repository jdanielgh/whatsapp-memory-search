// E2E del CLI de /sync (rules/dev-style.md, regla 4): corre
// `npm run sync` como proceso real (no llama funciones internas), igual
// que lo invocaría `pipeline-ops` o el usuario. Contra la base de datos
// de test efímera (nunca la de desarrollo). Todos los fixtures son
// texto inventado (rules/agents-and-context.md) — nunca la conversación
// real.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { testDatabaseUrl, testMigrationsDatabaseUrl } from "../../infrastructure/db/test-db.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";

const NBSP = " "; // espacio angosto de no separación real
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(currentDir, "../../..");

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// npm en Windows es un script (.cmd), no un ejecutable nativo: spawn()
// sin shell falla con EINVAL. Con shell:true hay que citar los
// argumentos a mano (Node ya no lo hace por vos, DEP0190) — acá son
// siempre rutas de archivo generadas por el propio test (mkdtemp), nunca
// entrada externa no confiable, pero se citan de todas formas.
function shellQuote(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const command = ["npm", "run", "sync", "--", ...args.map(shellQuote)].join(" ");
    const child = spawn(command, {
      cwd: PROJECT_ROOT,
      shell: true,
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        MIGRATIONS_DATABASE_URL: testMigrationsDatabaseUrl,
        ...extraEnv,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No se encontró JSON en la salida del CLI:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

describe("cli-import.ts (E2E, invocado como proceso real)", () => {
  let statusFilePath: string;

  beforeEach(async () => {
    await resetTestDatabase();
    const tmpDir = await mkdtemp(path.join(tmpdir(), "cma-e2e-"));
    statusFilePath = path.join(tmpDir, "status.json");
  });

  it("primera corrida: importa, y una segunda corrida sincroniza sin duplicar", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "cma-e2e-fixture-"));
    const firstFile = path.join(tmpDir, "export-1.txt");
    const secondFile = path.join(tmpDir, "export-2.txt");

    await writeFile(
      firstFile,
      [
        `[15/01/24, 09:00:00${NBSP}a.m.] Ana: Hola, ¿cómo estás?`,
        `[15/01/24, 09:01:00${NBSP}a.m.] Beto: Todo bien, gracias`,
        `[15/01/24, 09:02:00${NBSP}a.m.] Ana: ‎imagen omitida`,
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      secondFile,
      [
        `[15/01/24, 09:00:00${NBSP}a.m.] Ana: Hola, ¿cómo estás?`, // ya importado
        `[16/01/24, 10:00:00${NBSP}a.m.] Beto: Mensaje nuevo del día siguiente`,
      ].join("\n"),
      "utf8"
    );

    const first = await runCli(
      ["--file", firstFile, "--date-format", "dmy", "--timezone", "eu-cet-cest"],
      { CMA_STATUS_FILE_PATH: statusFilePath }
    );
    expect(first.exitCode).toBe(0);
    const firstSummary = extractJson(first.stdout) as {
      mode: string;
      messagesImported: number;
      messagesSkippedAsDuplicate: number;
      conversationId: string;
    };
    expect(firstSummary.mode).toBe("import");
    expect(firstSummary.messagesImported).toBe(3);
    expect(firstSummary.messagesSkippedAsDuplicate).toBe(0);

    const statusAfterFirst = JSON.parse(await readFile(statusFilePath, "utf8"));
    expect(statusAfterFirst.message_count).toBe(3);
    expect(statusAfterFirst.last_import_at).toBeTruthy();

    const second = await runCli(
      ["--file", secondFile, "--date-format", "dmy", "--timezone", "eu-cet-cest"],
      { CMA_STATUS_FILE_PATH: statusFilePath }
    );
    expect(second.exitCode).toBe(0);
    const secondSummary = extractJson(second.stdout) as {
      mode: string;
      messagesImported: number;
      messagesSkippedAsDuplicate: number;
      conversationId: string;
    };
    expect(secondSummary.mode).toBe("sync");
    expect(secondSummary.messagesImported).toBe(1);
    expect(secondSummary.messagesSkippedAsDuplicate).toBe(1);
    expect(secondSummary.conversationId).toBe(firstSummary.conversationId);

    const statusAfterSecond = JSON.parse(await readFile(statusFilePath, "utf8"));
    expect(statusAfterSecond.message_count).toBe(4);
  });

  it("falla con código de salida distinto de cero si faltan argumentos obligatorios", async () => {
    const result = await runCli(["--file", "no-importa.txt"], {
      CMA_STATUS_FILE_PATH: statusFilePath,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/date-format|timezone|utc-offset/i);
  });
});
