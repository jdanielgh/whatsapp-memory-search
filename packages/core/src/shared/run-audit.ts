// Datos de una corrida que se guardan en `system_audit_log` (plans/):
// qué motor ejecutó la IA, qué recurso consumió, si los datos salieron del
// equipo y con qué perfil de dominio. Sin esto, una interpretación derivada no
// dice qué motor la produjo (el modelo solo no alcanza: dos motores pueden
// servir un mismo nombre de modelo).
//
// Puro: no toca la base. Quien llama lo pasa a `recordAudit`.

import type { ProviderInfo } from "../infrastructure/ai/provider.js";
import type { AuditRecorder } from "./audit.js";
import type { DomainProfile } from "./domain-profile.js";
import { errorSummary as summarizeError } from "./error-summary.js";

export interface RunAuditInput {
  ai?: ProviderInfo;
  embeddings?: ProviderInfo;
  profile?: DomainProfile;
}

function providerSummary(info: ProviderInfo) {
  return {
    provider: info.name,
    billing: info.capabilities.billing,
    dataLeavesMachine: info.capabilities.dataLeavesMachine,
  };
}

export function describeRunForAudit(input: RunAuditInput): Record<string, unknown> {
  return {
    ...(input.ai ? { ai: providerSummary(input.ai) } : {}),
    ...(input.embeddings ? { embeddings: providerSummary(input.embeddings) } : {}),
    ...(input.profile ? { domainProfile: `${input.profile.id}@${input.profile.version}` } : {}),
  };
}

export interface AuditedRunOptions {
  /** Nombre del CLI o pipeline que ejecuta la corrida. */
  actor: string;
  /** Operación registrada, p. ej. "pipeline_run". */
  operation: string;
  conversationId: string;
  info: RunAuditInput;
  record: AuditRecorder;
}

/**
 * Ejecuta una corrida y deja constancia en `system_audit_log`, tanto si
 * termina como si falla (una corrida cortada por un límite de uso también
 * queda registrada). Nunca enmascara el error original: si registrar el
 * fallo también falla, se informa por stderr y se relanza el error de la
 * corrida. Los detalles no incluyen contenido de mensajes.
 */
export async function auditedRun<T>(
  options: AuditedRunOptions,
  run: () => Promise<T>,
  summarize: (result: T) => Record<string, unknown>
): Promise<T> {
  const base = describeRunForAudit(options.info);
  const entry = {
    actor: options.actor,
    operation: options.operation,
    resourceType: "Conversation",
    resourceId: options.conversationId,
  };

  let result: T;
  try {
    result = await run();
  } catch (error) {
    try {
      await options.record({
        ...entry,
        result: "failure",
        details: { ...base, errorSummary: errorSummary(error) },
      });
    } catch (auditError) {
      console.error(`No se pudo registrar el fallo de la corrida en la auditoría: ${errorSummary(auditError)}`);
    }
    throw error;
  }

  try {
    await options.record({ ...entry, result: "success", details: { ...base, ...summarize(result) } });
  } catch (auditError) {
    // El trabajo ya está hecho (y consumió recursos): no se descarta por un fallo de auditoría.
    console.error(`No se pudo registrar la corrida en la auditoría: ${errorSummary(auditError)}`);
  }
  return result;
}

// Causa más interna, no el envoltorio de drizzle con el SQL y sus parámetros
// (shared/error-summary.ts), recortada para la auditoría.
function errorSummary(error: unknown): string {
  return summarizeError(error).slice(0, 300);
}
