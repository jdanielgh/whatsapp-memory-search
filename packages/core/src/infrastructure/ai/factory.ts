// Fábrica de proveedores de IA (plans/). Es el ÚNICO lugar
// que conoce las clases concretas: los CLIs, scripts y casos de uso piden un
// proveedor por configuración y nunca hacen `new AnthropicProvider()`.
//
// Agregar un motor: escribir la clase (con `info`), registrarla acá y pasar
// la suite de contrato. Ver docs/AI_PROVIDERS.md cuando exista.

import { config } from "../../shared/config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import type { DescribedAIProvider, DescribedEmbeddingProvider } from "./provider.js";
import { ProviderRegistry } from "./registry.js";
import { RoutingProvider } from "./routing-provider.js";
import { VoyageEmbeddingProvider } from "./voyage-embedding-provider.js";

export interface ProviderSettings {
  /** Motor de completions (AI_PROVIDER). */
  aiProvider: string;
  /** Override para el tier "cheap" (AI_PROVIDER_CHEAP); null = usa `aiProvider`. */
  aiProviderCheap: string | null;
  /** Override para el tier "default" (AI_PROVIDER_DEFAULT); null = usa `aiProvider`. */
  aiProviderDefault: string | null;
  /** Motor de embeddings (EMBEDDING_PROVIDER). */
  embeddingProvider: string;
}

export const aiProviderRegistry = new ProviderRegistry<DescribedAIProvider>("completions");
export const embeddingProviderRegistry = new ProviderRegistry<DescribedEmbeddingProvider>("embeddings");

aiProviderRegistry.register("anthropic-api", () => new AnthropicProvider());
aiProviderRegistry.register("claude-code", () => new ClaudeCodeProvider());
embeddingProviderRegistry.register("voyage", () => new VoyageEmbeddingProvider());

/**
 * Proveedor de completions según la configuración. Si los dos tiers resuelven
 * al mismo motor se devuelve ese motor tal cual; si difieren, un
 * `RoutingProvider` delega por tier.
 */
export function createAIProvider(
  settings: ProviderSettings = config,
  registry: ProviderRegistry<DescribedAIProvider> = aiProviderRegistry
): DescribedAIProvider {
  const cheapName = settings.aiProviderCheap ?? settings.aiProvider;
  const defaultName = settings.aiProviderDefault ?? settings.aiProvider;
  if (cheapName === defaultName) return registry.create(defaultName);
  return new RoutingProvider({
    cheap: registry.create(cheapName),
    default: registry.create(defaultName),
  });
}

export function createEmbeddingProvider(
  settings: ProviderSettings = config,
  registry: ProviderRegistry<DescribedEmbeddingProvider> = embeddingProviderRegistry
): DescribedEmbeddingProvider {
  return registry.create(settings.embeddingProvider);
}
