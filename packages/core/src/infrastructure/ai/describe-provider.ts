// Texto del encabezado de una corrida: qué motor ejecuta la IA y a dónde van
// los datos (plans/). Se imprime por stderr para no
// ensuciar la salida JSON de los CLIs.

import type { ProviderInfo } from "./provider.js";

const BILLING_LABEL: Record<ProviderInfo["capabilities"]["billing"], string> = {
  api: "saldo de API",
  subscription: "cuota de suscripción",
  local: "máquina local",
};

const STRUCTURED_LABEL: Record<ProviderInfo["capabilities"]["structuredOutput"], string> = {
  native: "esquema forzado por el motor",
  prompt: "JSON pedido por prompt",
};

export function formatProviderInfo(info: ProviderInfo): string {
  const c = info.capabilities;
  return [
    info.name,
    `consume: ${BILLING_LABEL[c.billing]}`,
    `datos salen del equipo: ${c.dataLeavesMachine ? "sí" : "no"}`,
    STRUCTURED_LABEL[c.structuredOutput],
  ].join(" · ");
}

/** Líneas del encabezado; omite la que no aplica a la corrida (p. ej. embeddings en Entity Detection). */
export function formatRunHeader(providers: {
  ai?: ProviderInfo;
  embeddings?: ProviderInfo;
  /**
   * Perfil de dominio activo. Cambia los prompts y las categorías, así que una
   * comparación entre dos corridas con perfiles distintos mezcla dos variables
   * (el motor y el perfil): tiene que ser visible en cada corrida.
   */
  profile?: { id: string; version: number };
}): string {
  const lines: string[] = [];
  if (providers.ai) lines.push(`IA: ${formatProviderInfo(providers.ai)}`);
  if (providers.embeddings) lines.push(`Embeddings: ${formatProviderInfo(providers.embeddings)}`);
  if (providers.profile) {
    lines.push(`Perfil de dominio: ${providers.profile.id}@${providers.profile.version}`);
  }
  return lines.join("\n");
}
