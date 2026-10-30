// Puente con el hook .claude/hooks/session-start.sh (plans/,
// tarea 6). Escribe/actualiza .claude/state/status.json de forma
// incremental (merge, no overwrite completo) para que distintos
// llamadores (importación, backup) puedan actualizar solo lo que saben,
// sin pisar el resto.
//
// Este archivo es estado derivado, regenerable — nunca evidencia. Está
// en .gitignore a propósito.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../shared/config.js";

export interface StatusFile {
  last_import_at?: string;
  message_count?: number;
  open_cases_count?: number;
  pending_reminders_count?: number;
  last_backup_at?: string;
}

async function readStatus(filePath: string): Promise<StatusFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StatusFile;
  } catch {
    // No existe todavía, o está corrupto — se reconstruye desde cero.
    // No es evidencia, no hay nada que preservar a toda costa aquí.
    return {};
  }
}

/** Firma de updateStatus, para inyectarla como dependencia en casos de uso. */
export type StatusUpdater = (partial: Partial<StatusFile>) => Promise<void>;

export async function updateStatus(
  partial: Partial<StatusFile>,
  filePath: string = config.statusFilePath
): Promise<void> {
  const current = await readStatus(filePath);
  const next: StatusFile = { ...current, ...partial };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}
