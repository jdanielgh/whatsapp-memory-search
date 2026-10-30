// Helper único de auditoría (Governance Layer, docs/ARCHITECTURE.md). Todas
// las fases posteriores registran operaciones relevantes aquí en vez de
// reinventar logging por módulo. system_audit_log nunca se borra
// (docs/SECURITY.md) — este helper solo inserta, nunca actualiza ni elimina.

import { db } from "../infrastructure/db/client.js";
import { systemAuditLog } from "../infrastructure/db/schema.js";

export interface AuditEntry {
  /** "user" o el nombre del pipeline/proceso que ejecuta la operación. */
  actor: string;
  operation: string;
  resourceType: string;
  resourceId?: string;
  result: "success" | "failure";
  details?: Record<string, unknown>;
}

/** Firma de recordAudit, para inyectarla como dependencia en casos de uso. */
export type AuditRecorder = (entry: AuditEntry) => Promise<void>;

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await db.insert(systemAuditLog).values({
    occurredAt: new Date(),
    actor: entry.actor,
    operation: entry.operation,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    result: entry.result,
    details: entry.details,
  });
}
