import { describe, expect, it } from "vitest";
import { UsageAccumulator } from "./ai-cost.js";

const usage = (model: string, input: number, output: number, cacheRead = 0) => ({
  model,
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
});

describe("UsageAccumulator", () => {
  it("suma llamadas y tokens por modelo", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5", 1000, 100));
    acc.record(usage("claude-haiku-4-5", 500, 50));

    const rows = acc.summary();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calls).toBe(2);
    expect(rows[0]?.inputTokens).toBe(1500);
    expect(rows[0]?.outputTokens).toBe(150);
  });

  it("no mezcla modelos distintos en un solo total", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5", 1_000_000, 0));
    acc.record(usage("claude-sonnet-5", 1_000_000, 0));

    const rows = acc.summary(new Date("2026-09-01"));
    expect(rows).toHaveLength(2);
    // Precios de lista distintos: Haiku $1/MTok vs Sonnet $3/MTok.
    expect(rows.find((r) => r.model === "claude-haiku-4-5")?.estimatedUsd).toBeCloseTo(1);
    expect(rows.find((r) => r.model === "claude-sonnet-5")?.estimatedUsd).toBeCloseTo(3);
  });

  it("aplica el precio introductorio de Sonnet 5 solo hasta su vencimiento", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-sonnet-5", 1_000_000, 1_000_000));

    // Vigente el último día inclusive: $2 entrada + $10 salida.
    expect(acc.totalUsd(new Date("2026-08-31"))).toBeCloseTo(12);
    // Al día siguiente pasa a lista: $3 + $15. Si esto se rompiera, toda
    // estimación posterior a agosto subestimaría el gasto casi a la mitad.
    expect(acc.totalUsd(new Date("2026-09-01"))).toBeCloseTo(18);
  });

  it("cobra los tokens leídos de caché a 0.1x y aparte de los de entrada", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5", 0, 0, 1_000_000));
    expect(acc.totalUsd(new Date("2026-09-01"))).toBeCloseTo(0.1);
  });

  it("reconoce los IDs con sufijo de fecha como el mismo modelo tarifado", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5-20251001", 1_000_000, 0));
    expect(acc.totalUsd(new Date("2026-09-01"))).toBeCloseTo(1);
  });

  it("un consumo de suscripción cuenta llamadas y tokens pero no se convierte a USD", () => {
    const acc = new UsageAccumulator();
    // Un nombre que SÍ está en la tabla de precios: si se tarifara, daría dinero que nadie pagó.
    acc.record({ ...usage("claude-sonnet-5", 1_000_000, 1_000_000), billing: "subscription" });

    const [row] = acc.summary(new Date("2026-09-01"));
    expect(row?.billing).toBe("subscription");
    expect(row?.estimatedUsd).toBe(0);
    expect(row?.inputTokens).toBe(1_000_000);
    expect(acc.totalUsd(new Date("2026-09-01"))).toBe(0);
  });

  it("un modelo local tampoco se tarifa", () => {
    const acc = new UsageAccumulator();
    acc.record({ ...usage("llama-local", 500, 500), billing: "local" });
    expect(acc.summary()[0]?.estimatedUsd).toBe(0);
    expect(acc.totalUsd()).toBe(0);
  });

  it("sin 'billing' se asume API, como antes de existir varios motores", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5", 1_000_000, 0));
    const [row] = acc.summary(new Date("2026-09-01"));
    expect(row?.billing).toBe("api");
    expect(row?.estimatedUsd).toBeCloseTo(1);
  });

  it("no suma en un renglón el mismo modelo servido con facturaciones distintas", () => {
    const acc = new UsageAccumulator();
    acc.record({ ...usage("claude-sonnet-5", 1_000_000, 0), billing: "api" });
    acc.record({ ...usage("claude-sonnet-5", 1_000_000, 0), billing: "subscription" });
    expect(acc.summary(new Date("2026-09-01"))).toHaveLength(2);
    // Solo el consumo de API aporta dinero al total.
    expect(acc.totalUsd(new Date("2026-09-01"))).toBeCloseTo(3);
  });

  it("el informe de suscripción habla de cuota y no muestra USD ni '?'", () => {
    const acc = new UsageAccumulator();
    acc.record({ ...usage("claude-sonnet-5-5", 4000, 1500, 700), billing: "subscription" });
    const text = acc.report();
    expect(text).toContain("cuota de suscripción");
    expect(text).toContain("1 llamadas");
    expect(text).toContain("sin costo en USD");
    expect(text).not.toContain("?");
    expect(text).not.toContain("Total en USD");
  });

  it("el informe de API muestra el total en USD y avisa si un modelo no tiene tarifa", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("claude-haiku-4-5", 1_000_000, 0));
    expect(acc.report(new Date("2026-09-01"))).toContain("Total en USD: 1.0000");

    const unknown = new UsageAccumulator();
    unknown.record(usage("modelo-inexistente", 10, 10));
    expect(unknown.report()).toContain("sin tarifa conocida");
    expect(unknown.report()).toContain("Total en USD: desconocido");
  });

  it("sin consumo, el informe lo dice", () => {
    expect(new UsageAccumulator().report()).toBe("Sin consumo registrado.");
  });

  it("reporta tokens pero no inventa un costo para un modelo desconocido", () => {
    const acc = new UsageAccumulator();
    acc.record(usage("modelo-inexistente", 1_000_000, 0));

    const rows = acc.summary();
    expect(rows[0]?.inputTokens).toBe(1_000_000);
    expect(rows[0]?.estimatedUsd).toBeNull();
    expect(acc.totalUsd()).toBeNull();
  });
});
