// Tests del cliente HTTP de Voyage. No llaman a la API real
// (rules/ai-cost.md regla 1): `fetch` se inyecta como fake determinista,
// mismo criterio que el mock del SDK de Anthropic en
// anthropic-provider.test.ts. `sleep` también se inyecta para que los
// tests de reintento no esperen los backoffs reales.

import { describe, expect, it, vi } from "vitest";

// embed() (el método legado de AIProvider) resuelve dimensiones desde
// config cuando el caller no las pasa — se mockea para que este archivo
// no dependa de lo que haya en el .env real de quien corra los tests.
vi.mock("../../shared/config.js", () => ({
  config: { voyageApiKey: "", embeddingModel: "voyage-3-large", embeddingDimensions: 2 },
}));

const { EmbeddingValidationError } = await import("./provider.js");
const { VoyageEmbeddingProvider, DEFAULT_MAX_BATCH_SIZE } = await import(
  "./voyage-embedding-provider.js"
);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("VoyageEmbeddingProvider", () => {
  it("rechaza construirse sin API key", () => {
    expect(() => new VoyageEmbeddingProvider("")).toThrow(/VOYAGE_API_KEY/);
  });

  it("arma el request con model, input_type y output_dimension", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ index: 0, embedding: [0.1, 0.2] }],
        model: "voyage-3-large",
        usage: { total_tokens: 5 },
      })
    );
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    await provider.embedBatch(["hola"], {
      model: "voyage-3-large",
      dimensions: 2,
      inputType: "document",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      input: ["hola"],
      model: "voyage-3-large",
      input_type: "document",
      output_dimension: 2,
    });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("devuelve los vectores reordenados por índice, no por orden de llegada", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      })
    );
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    const vectors = await provider.embedBatch(["primero", "segundo"], {
      model: "voyage-3-large",
      dimensions: 2,
      inputType: "document",
    });

    expect(vectors).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("reporta el modelo y los tokens consumidos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ index: 0, embedding: [1] }],
        model: "voyage-3-large",
        usage: { total_tokens: 42 },
      })
    );
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);
    const seen: unknown[] = [];

    await provider.embedBatch(["hola"], {
      model: "voyage-3-large",
      dimensions: 1,
      inputType: "document",
      onUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ model: "voyage-3-large", totalTokens: 42 }]);
  });

  it("rechaza un lote más grande que el tope, sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);
    const texts = Array.from({ length: DEFAULT_MAX_BATCH_SIZE + 1 }, () => "x");

    await expect(
      provider.embedBatch(texts, { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toThrow(/tope/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no reintenta ante credencial inválida (401) — falla de inmediato", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const provider = new VoyageEmbeddingProvider("k", async () => {}, fetchImpl);

    await expect(
      provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toThrow(/VOYAGE_API_KEY|credencial/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reintenta ante 429 y tiene éxito en el segundo intento", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    const sleeps: number[] = [];
    const provider = new VoyageEmbeddingProvider(
      "k",
      async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl
    );

    const vectors = await provider.embedBatch(["hola"], {
      model: "m",
      dimensions: 1,
      inputType: "document",
    });

    expect(vectors).toEqual([[1]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
  });

  it("respeta el header Retry-After en vez del backoff exponencial", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    const sleeps: number[] = [];
    const provider = new VoyageEmbeddingProvider(
      "k",
      async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl
    );

    await provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" });

    expect(sleeps).toEqual([2000]);
  });

  it("agota los reintentos y falla con un mensaje claro", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const provider = new VoyageEmbeddingProvider("k", async () => {}, fetchImpl);

    await expect(
      provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toThrow(/agotados/);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  // Regresión del hallazgo del smoke test real: los límites de Voyage son
  // POR MINUTO, así que un backoff de milisegundos reintenta dentro de la
  // misma ventana y agota los intentos sin que la cuota se haya despejado.
  it("ante 429 espera en el orden de segundos, no de milisegundos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { detail: "rate limited" }));
    const sleeps: number[] = [];
    const provider = new VoyageEmbeddingProvider(
      "k",
      async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl
    );

    await expect(
      provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toThrow(/agotados/);

    expect(sleeps).toEqual([5000, 10000, 20000, 40000]);
    // Cruza una ventana de un minuto completa, que es lo que un límite
    // RPM/TPM necesita para despejarse.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(60000);
  });

  it("un 5xx sigue reintentando rápido: no hereda el backoff largo de 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    const sleeps: number[] = [];
    const provider = new VoyageEmbeddingProvider(
      "k",
      async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl
    );

    await provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" });

    expect(sleeps).toEqual([500]);
  });

  // Regresión del segundo hallazgo del smoke test real: Voyage no rechaza
  // un texto que excede la ventana del modelo, lo trunca en silencio y
  // devuelve un vector con pinta de válido. El corte tiene que ser local.
  it("corta un texto desmedido antes de salir a la red, no lo deja truncar en silencio", async () => {
    const fetchImpl = vi.fn();
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    await expect(
      provider.embedBatch(["x".repeat(96_001)], {
        model: "m",
        dimensions: 1,
        inputType: "document",
      })
    ).rejects.toBeInstanceOf(EmbeddingValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un 400 (validación) no se reintenta y se distingue como EmbeddingValidationError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "text too long" }));
    const provider = new VoyageEmbeddingProvider("k", async () => {}, fetchImpl);

    await expect(
      provider.embedBatch(["hola"], { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toBeInstanceOf(EmbeddingValidationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("una respuesta con menos vectores que textos pedidos es EmbeddingValidationError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    await expect(
      provider.embedBatch(["uno", "dos"], { model: "m", dimensions: 1, inputType: "document" })
    ).rejects.toBeInstanceOf(EmbeddingValidationError);
  });

  it("un vector con dimensión distinta a la pedida es EmbeddingValidationError", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    await expect(
      provider.embedBatch(["hola"], { model: "m", dimensions: 1024, inputType: "document" })
    ).rejects.toBeInstanceOf(EmbeddingValidationError);
  });

  it("embed() (AIProvider) delega en embedBatch con inputType 'document'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1, 2] }] }));
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);

    const vector = await provider.embed("hola", { model: "voyage-3-large" });

    expect(vector).toEqual([1, 2]);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.input_type).toBe("document");
  });

  it("complete() falla explícito: Voyage no ofrece completions", async () => {
    const provider = new VoyageEmbeddingProvider("k", undefined, vi.fn());
    await expect(provider.complete("hola")).rejects.toThrow(/no está implementado/);
  });

  it("embedBatch([]) devuelve [] sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const provider = new VoyageEmbeddingProvider("k", undefined, fetchImpl);
    expect(await provider.embedBatch([], { model: "m", dimensions: 1, inputType: "query" })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
