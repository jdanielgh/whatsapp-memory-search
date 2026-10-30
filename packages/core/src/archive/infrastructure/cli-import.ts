// CLI mínima para el comando /sync (.claude/commands/sync.md): importa
// (primera vez) o sincroniza (Conversation ya existente) un export de
// WhatsApp. Uso:
//   npm run sync --   (desde la raíz del monorepo)
//     --file <ruta> --date-format <dmy|mdy> \
//     (--timezone eu-cet-cest | --utc-offset <minutos>) \
//     [--title <titulo>] [--roles "Nombre1=rol1,Nombre2=rol2"]
//
// Sin defaults silenciosos para el huso horario/--date-format (mismo
// criterio que ParseOptions en whatsapp-parser.ts): hay que elegir
// --timezone eu-cet-cest (Europa central, con horario de verano) o un
// --utc-offset fijo (solo correcto si el export no cruza ningún cambio
// de horario de verano). Nunca imprime contenido de mensajes, solo el
// resumen numérico (rules/security-privacy.md).
//
// Roles de participantes (docs/DATA_MODEL.md: participants.role):
// PARTICIPANT_ROLE_MAP en .env es la base para cualquier participante
// real nuevo; --roles sobreescribe puntualmente esa base solo para esta
// corrida. Sin ninguno de los dos, un remitente nuevo queda en
// UNKNOWN_PARTICIPANT_ROLE ("desconocido") — nunca se infiere del nombre
// (docs/DECISIONS.md, entrada 2026-08-04).

import { mkdir, open as openFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../../shared/config.js";
import { parseParticipantRoles } from "../../shared/participant-roles.js";
import { recordAudit } from "../../shared/audit.js";
import { updateStatus } from "../../infrastructure/status-writer.js";
import type { TimeZoneStrategy } from "./whatsapp-parser.js";
import type { ImportConversationDeps } from "../use-cases/import-conversation.js";
import { importConversation } from "../use-cases/import-conversation.js";
import { syncNewMessages } from "../use-cases/sync-new-messages.js";
import { DrizzleConversationRepository } from "./conversation-repository.drizzle.js";
import { DrizzleImportJobRepository } from "./import-job-repository.drizzle.js";
import { errorSummary } from "../../shared/error-summary.js";

// getOrCreateConversation/getOrCreateParticipant/filterNewContentHashes
// son check-then-act (docs/ERROR_HANDLING.md no cubre corridas
// concurrentes) — un lockfile de proceso serializa las invocaciones de
// esta CLI, que es el único punto de entrada de producción, para que dos
// `npm run sync` solapados no dupliquen Conversations/Participants/
// Messages.
const LOCK_PATH = path.join(path.dirname(config.statusFilePath), "import.lock");

async function acquireImportLock(): Promise<() => Promise<void>> {
  await mkdir(path.dirname(LOCK_PATH), { recursive: true });
  let handle;
  try {
    handle = await openFile(LOCK_PATH, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Ya hay una importación/sincronización en curso (lock: ${LOCK_PATH}). Esperá a que termine antes de reintentar.`
      );
    }
    throw err;
  }
  await handle.close();
  return async () => {
    await unlink(LOCK_PATH).catch(() => {});
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        `Argumento inválido cerca de "${key ?? ""}". Uso: --file <ruta> --date-format <dmy|mdy> (--timezone eu-cet-cest | --utc-offset <minutos>) [--title <titulo>]`
      );
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function resolveTimeZoneArg(args: Map<string, string>): TimeZoneStrategy {
  const timezoneRaw = args.get("timezone");
  const utcOffsetRaw = args.get("utc-offset");

  if (timezoneRaw && utcOffsetRaw) {
    throw new Error("Pasá --timezone o --utc-offset, no los dos a la vez.");
  }
  if (timezoneRaw) {
    if (timezoneRaw !== "eu-cet-cest") {
      throw new Error(`--timezone solo soporta "eu-cet-cest" por ahora, recibido: "${timezoneRaw}".`);
    }
    return { kind: "eu-cet-cest" };
  }
  if (utcOffsetRaw) {
    const utcOffsetMinutes = Number(utcOffsetRaw);
    if (Number.isNaN(utcOffsetMinutes)) {
      throw new Error(`--utc-offset debe ser numérico, recibido: "${utcOffsetRaw}".`);
    }
    return { kind: "fixed", utcOffsetMinutes };
  }
  throw new Error(
    "Falta el huso horario: pasá --timezone eu-cet-cest o --utc-offset <minutos> (sin default silencioso)."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.get("file");
  const dateFormatRaw = args.get("date-format");

  if (!filePath || !dateFormatRaw) {
    throw new Error(
      "Faltan argumentos obligatorios: --file, --date-format (sin defaults silenciosos)."
    );
  }
  if (dateFormatRaw !== "dmy" && dateFormatRaw !== "mdy") {
    throw new Error(`--date-format debe ser "dmy" o "mdy", recibido: "${dateFormatRaw}".`);
  }
  const dateFormat = dateFormatRaw;
  const timeZone = resolveTimeZoneArg(args);
  // Base = PARTICIPANT_ROLE_MAP (.env), --roles la sobreescribe puntualmente
  // por nombre para esta corrida sin tener que tocar el .env.
  const rolesRaw = args.get("roles");
  const mergedRoles = {
    ...config.defaultParticipantRoles,
    ...(rolesRaw ? parseParticipantRoles(rolesRaw) : {}),
  };
  const participantRoles =
    Object.keys(mergedRoles).length > 0 ? mergedRoles : undefined;

  // npm ejecuta el script con cwd = packages/core; INIT_CWD es el
  // directorio desde donde se lanzó `npm run sync`, así una ruta relativa
  // sigue apuntando a donde la escribió quien corrió el comando.
  const rawExport = await readFile(
    path.resolve(config.invocationCwd, filePath),
    "utf8"
  );

  const deps: ImportConversationDeps = {
    conversationRepo: new DrizzleConversationRepository(),
    importJobRepo: new DrizzleImportJobRepository(),
    audit: recordAudit,
    updateStatus,
  };

  const releaseLock = await acquireImportLock();
  let result: Awaited<ReturnType<typeof importConversation>>;
  let mode: "sync" | "import";
  try {
    const existing = await deps.conversationRepo.findConversation();
    mode = existing ? "sync" : "import";
    result = existing
      ? await syncNewMessages(deps, {
          rawExport,
          timeZone,
          dateFormat,
          participantRoles,
        })
      : await importConversation(deps, {
          rawExport,
          timeZone,
          dateFormat,
          participantRoles,
          conversationTitle: args.get("title") ?? null,
        });
  } finally {
    await releaseLock();
  }

  console.log(
    JSON.stringify(
      {
        mode,
        conversationId: result.conversationId,
        importJobId: result.importJobId,
        messagesImported: result.messagesImported,
        messagesSkippedAsDuplicate: result.messagesSkippedAsDuplicate,
        parseWarningsCount: result.parseWarnings.length,
      },
      null,
      2
    )
  );

  if (result.parseWarnings.length > 0) {
    console.warn(
      `${result.parseWarnings.length} línea(s) generaron warnings de parseo — revisar el ImportJob ${result.importJobId} (system_audit_log) para el detalle estructural.`
    );
  }
}

main().catch((err) => {
  console.error(errorSummary(err));
  process.exitCode = 1;
});
