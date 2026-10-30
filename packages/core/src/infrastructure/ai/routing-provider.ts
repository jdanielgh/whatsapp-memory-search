// Delega cada llamada en un motor según el `tier` pedido
// (plans/, "override por tier"). Permite combinar motores:
// por ejemplo uno barato para Entity Detection (alto volumen) y otro de más
// calidad para Event Detection, sin que los casos de uso se enteren.

import type {
  CompletionOptions,
  DescribedAIProvider,
  EmbeddingOptions,
  ProviderInfo,
} from "./provider.js";

export interface RoutingTargets {
  cheap: DescribedAIProvider;
  default: DescribedAIProvider;
}

export class RoutingProvider implements DescribedAIProvider {
  readonly info: ProviderInfo;

  constructor(private readonly targets: RoutingTargets) {
    const { cheap, default: main } = targets;
    this.info = {
      name: `cheap=${cheap.info.name}, default=${main.info.name}`,
      // Lo más conservador de los dos: si alguno saca los datos del equipo,
      // el conjunto los saca.
      capabilities: {
        structuredOutput:
          cheap.info.capabilities.structuredOutput === "native" &&
          main.info.capabilities.structuredOutput === "native"
            ? "native"
            : "prompt",
        usage: weakestUsage(cheap.info.capabilities.usage, main.info.capabilities.usage),
        billing: mixedBilling(cheap, main),
        dataLeavesMachine:
          cheap.info.capabilities.dataLeavesMachine || main.info.capabilities.dataLeavesMachine,
        supportsThinking: main.info.capabilities.supportsThinking,
      },
    };
  }

  async ensureReady(): Promise<void> {
    await this.targets.cheap.ensureReady?.();
    await this.targets.default.ensureReady?.();
  }

  complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
    // Sin tier se usa el principal: es lo que hace AnthropicProvider.
    return this.pick(opts.tier).complete(prompt, opts);
  }

  embed(text: string, opts?: EmbeddingOptions): Promise<number[]> {
    return this.targets.default.embed(text, opts);
  }

  private pick(tier: CompletionOptions["tier"]): DescribedAIProvider {
    return tier === "cheap" ? this.targets.cheap : this.targets.default;
  }
}

const USAGE_ORDER = ["none", "estimated", "exact"] as const;

function weakestUsage(
  a: ProviderInfo["capabilities"]["usage"],
  b: ProviderInfo["capabilities"]["usage"]
): ProviderInfo["capabilities"]["usage"] {
  return USAGE_ORDER[Math.min(USAGE_ORDER.indexOf(a), USAGE_ORDER.indexOf(b))] ?? "none";
}

/** Con facturaciones distintas el conjunto se reporta por la que cuesta dinero (api > suscripción > local). */
function mixedBilling(a: DescribedAIProvider, b: DescribedAIProvider): ProviderInfo["capabilities"]["billing"] {
  const order = ["local", "subscription", "api"] as const;
  const rank = (p: DescribedAIProvider) => order.indexOf(p.info.capabilities.billing);
  return order[Math.max(rank(a), rank(b))] ?? "api";
}
