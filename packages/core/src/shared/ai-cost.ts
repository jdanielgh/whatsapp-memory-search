// Contabilidad de consumo de la API de Anthropic para las corridas
// reales. Existe para poder cumplir `rules/ai-cost.md` regla 5
// ("registrar el costo REAL observado, no solo el estimado") sin tener
// que ir a mirar la consola de Anthropic a mano después de cada corrida.
//
// No participa del dominio: los pipelines acumulan tokens vía el callback
// `CompletionOptions.onUsage` y el CLI de turno reporta el total.

import type { TokenUsage } from "../infrastructure/ai/provider.js";

/**
 * Precios en USD por millón de tokens, consultados en la documentación
 * oficial el 2026-08-03. Se guardan acá, y no en el dominio, porque son
 * política de facturación de Anthropic y cambian.
 *
 * `introOutputUntil` refleja el precio introductorio de Sonnet 5, vigente
 * hasta el 2026-08-31 inclusive. Después de esa fecha el cálculo usa el
 * precio de lista automáticamente — sin esto, toda estimación posterior a
 * agosto subestimaría el gasto casi a la mitad.
 */
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  intro?: {
    until: string; // ISO date, inclusive
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    intro: { until: "2026-08-31", inputPerMillion: 2, outputPerMillion: 10 },
  },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

/** Los IDs con sufijo de fecha (`claude-haiku-4-5-20251001`) comparten precio con su alias. */
function pricingFor(model: string): ModelPricing | null {
  const exact = PRICING[model];
  if (exact) return exact;
  const alias = Object.keys(PRICING).find((key) => model.startsWith(key));
  return alias ? PRICING[alias] ?? null : null;
}

type Billing = NonNullable<TokenUsage["billing"]>;

export interface RunCost {
  model: string;
  /** Qué recurso se consumió. Solo "api" se convierte a USD. */
  billing: Billing;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /**
   * Dinero estimado. 0 si el consumo no es de API (suscripción o local: no se
   * paga por token). null si es de API pero el modelo no está en la tabla de
   * precios — se reportan los tokens igual, sin inventar un número.
   */
  estimatedUsd: number | null;
}

/**
 * Acumula el consumo de una corrida. Un acumulador por modelo, porque
 * mezclar tokens de Haiku y de Sonnet en un solo total haría que el
 * costo en USD no se pueda reconstruir después.
 */
export class UsageAccumulator {
  // Clave "<facturación>|<modelo>": el mismo nombre de modelo servido por dos
  // motores con facturación distinta no debe sumarse en un solo renglón.
  private readonly totals = new Map<
    string,
    { model: string; billing: Billing; calls: number; input: number; output: number; cacheRead: number }
  >();

  /** Pasar como `onUsage` a `AIProvider.complete()` — está bindeado para poder usarse como callback directo. */
  record = (usage: TokenUsage): void => {
    const model = usage.model;
    const billing = usage.billing ?? "api";
    const key = `${billing}|${model}`;
    const current = this.totals.get(key) ?? {
      model,
      billing,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
    };
    current.calls += 1;
    current.input += usage.inputTokens;
    current.output += usage.outputTokens;
    current.cacheRead += usage.cacheReadInputTokens;
    this.totals.set(key, current);
  };

  /** `now` es inyectable para que los tests no dependan de la fecha real (el precio introductorio vence). */
  summary(now: Date = new Date()): RunCost[] {
    const today = now.toISOString().slice(0, 10);
    return [...this.totals.values()].map((t) => {
      const { model, billing } = t;
      const pricing = billing === "api" ? pricingFor(model) : null;
      // Suscripción y local no se pagan por token: 0 USD, no "desconocido".
      let estimatedUsd: number | null = billing === "api" ? null : 0;
      if (pricing) {
        const rate =
          pricing.intro && today <= pricing.intro.until
            ? pricing.intro
            : pricing;
        // Los tokens leídos de caché se facturan a ~0.1x del precio de
        // entrada y NO están incluidos en input_tokens (que reporta solo
        // el remanente no cacheado).
        estimatedUsd =
          (t.input / 1_000_000) * rate.inputPerMillion +
          (t.cacheRead / 1_000_000) * rate.inputPerMillion * 0.1 +
          (t.output / 1_000_000) * rate.outputPerMillion;
      }
      return {
        model,
        billing,
        calls: t.calls,
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadInputTokens: t.cacheRead,
        estimatedUsd,
      };
    });
  }

  totalUsd(now: Date = new Date()): number | null {
    const rows = this.summary(now);
    if (rows.length === 0) return 0;
    if (rows.some((r) => r.estimatedUsd === null)) return null;
    return rows.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0);
  }

  /**
   * Informe legible del consumo, según lo que se haya gastado de verdad: USD
   * para API, llamadas y tokens para suscripción o máquina local. Existe para
   * que un informe de suscripción no diga "USD ?" ni muestre un precio de API
   * que nadie pagó.
   */
  report(now: Date = new Date()): string {
    const rows = this.summary(now);
    if (rows.length === 0) return "Sin consumo registrado.";
    const lines = rows.map((r) => {
      const tokens = `${r.inputTokens} de entrada + ${r.cacheReadInputTokens} de caché · ${r.outputTokens} de salida`;
      const where = BILLING_LABEL[r.billing];
      const money =
        r.billing === "api"
          ? r.estimatedUsd === null
            ? "USD sin tarifa conocida para este modelo"
            : `USD ${r.estimatedUsd.toFixed(4)}`
          : "sin costo en USD";
      return `${r.model} (${where}): ${r.calls} llamadas · ${tokens} · ${money}`;
    });
    const usd = this.totalUsd(now);
    if (rows.some((r) => r.billing === "api")) {
      lines.push(usd === null ? "Total en USD: desconocido" : `Total en USD: ${usd.toFixed(4)}`);
    }
    return lines.join("\n");
  }
}

const BILLING_LABEL: Record<Billing, string> = {
  api: "saldo de API",
  subscription: "cuota de suscripción",
  local: "máquina local",
};
