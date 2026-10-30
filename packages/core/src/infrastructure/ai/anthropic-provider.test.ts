// Tests del payload que AnthropicProvider le arma a la API. No llaman a
// la API real (rules/ai-cost.md regla 1): el SDK está mockeado y lo que
// se verifica es el request construido.
//
// Existen porque las dos cosas que este archivo corrige fallan de forma
// silenciosa y cara: reenviar `temperature` hace que Sonnet 5 devuelva
// HTTP 400 en la primera llamada real, y dejar el razonamiento en su
// default hace que Sonnet 5 facture tokens de razonamiento como salida
// sobre miles de mensajes. Ninguna de las dos se nota sin correr contra
// la API — o sea, sin gastar (rules/dev-style.md regla 4).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create };
  },
}));

vi.mock("../../shared/config.js", () => ({
  config: {
    anthropicApiKey: "clave-de-prueba",
    aiModelDefault: "modelo-caro",
    aiModelCheap: "modelo-barato",
  },
}));

const { AnthropicProvider } = await import("./anthropic-provider.js");

const textResponse = {
  content: [{ type: "text", text: "hola" }],
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 },
};

/** Último request que el provider le pasó al SDK. */
function lastRequest(): Record<string, unknown> {
  return create.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("AnthropicProvider.complete", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue(textResponse);
  });

  it("nunca envía temperature (Sonnet 5 responde 400 ante un valor no-default)", async () => {
    await new AnthropicProvider("k").complete("hola");
    expect(lastRequest()).not.toHaveProperty("temperature");
    expect(lastRequest()).not.toHaveProperty("top_p");
    expect(lastRequest()).not.toHaveProperty("top_k");
  });

  it("apaga el razonamiento en el tier default, donde Sonnet 5 razonaría por defecto", async () => {
    await new AnthropicProvider("k").complete("hola", { tier: "default" });
    expect(lastRequest().model).toBe("modelo-caro");
    expect(lastRequest().thinking).toEqual({ type: "disabled" });
  });

  it("no manda thinking en el tier cheap, que ya viene sin razonamiento", async () => {
    await new AnthropicProvider("k").complete("hola", { tier: "cheap" });
    expect(lastRequest().model).toBe("modelo-barato");
    // Mandarlo no cambiaría el comportamiento y metería un parámetro no
    // verificado en el pipeline de mayor volumen.
    expect(lastRequest()).not.toHaveProperty("thinking");
  });

  it("pide razonamiento adaptativo solo cuando se solicita explícitamente", async () => {
    await new AnthropicProvider("k").complete("hola", {
      thinking: "adaptive",
      maxTokens: 8000,
    });
    expect(lastRequest().thinking).toEqual({ type: "adaptive" });
  });

  it("rechaza razonamiento adaptativo sin margen de tokens, antes de gastar", async () => {
    await expect(
      new AnthropicProvider("k").complete("hola", { thinking: "adaptive" })
    ).rejects.toThrow(/maxTokens/);
    // Lo importante: no llegó a llamar a la API, así que no se facturó.
    expect(create).not.toHaveBeenCalled();
  });

  it("fuerza tool-use cuando se pide jsonSchema, en vez de confiar en el prompt", async () => {
    create.mockResolvedValue({
      content: [{ type: "tool_use", input: { entities: [] } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });

    const raw = await new AnthropicProvider("k").complete("hola", {
      jsonSchema: { type: "object" },
    });

    expect(lastRequest().tool_choice).toEqual({
      type: "tool",
      name: "respond_with_structured_output",
    });
    expect(JSON.parse(raw)).toEqual({ entities: [] });
  });

  it("detecta el truncamiento por max_tokens en vez de devolver un objeto incompleto", async () => {
    // Con tool-use, Anthropic devuelve el input PARCIAL cuando corta por
    // max_tokens: el JSON es sintácticamente válido, así que sin esta
    // comprobación el parseo río abajo falla culpando al modelo por un
    // campo faltante. Fallo silencioso sobre una llamada ya facturada
    // (rules/dev-style.md regla 4).
    create.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", input: { answer: "quedó a mitad" } }],
      usage: { input_tokens: 2000, output_tokens: 2048, cache_read_input_tokens: 0 },
    });

    await expect(
      new AnthropicProvider("k").complete("hola", { jsonSchema: { type: "object" } })
    ).rejects.toThrow(/trunc/i);
  });

  it("no confunde una respuesta completa con una truncada", async () => {
    create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", input: { sufficient_evidence: true } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });

    const raw = await new AnthropicProvider("k").complete("hola", {
      jsonSchema: { type: "object" },
    });
    expect(JSON.parse(raw)).toEqual({ sufficient_evidence: true });
  });

  it("reporta el modelo junto con los tokens, para poder convertirlos a USD", async () => {
    const seen: unknown[] = [];
    await new AnthropicProvider("k").complete("hola", {
      tier: "cheap",
      onUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      {
        model: "modelo-barato",
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        billing: "api",
      },
    ]);
  });

  it("no pierde una respuesta ya facturada si falla la contabilidad de costos", async () => {
    const provider = new AnthropicProvider("k");
    await expect(
      provider.complete("hola", {
        onUsage: () => {
          throw new Error("bug en el acumulador");
        },
      })
    ).resolves.toBe("hola");
  });
});
