// La fábrica decide a dónde van los datos y qué se consume: un error acá
// manda mensajes a un motor que nadie eligió. Sin llamadas reales
// (rules/ai-cost.md): proveedores falsos registrados en registros propios.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/config.js", () => ({
  config: {
    aiProvider: "anthropic-api",
    aiProviderCheap: null,
    aiProviderDefault: null,
    embeddingProvider: "voyage",
    anthropicApiKey: "k",
    voyageApiKey: "k",
    aiModelCheap: "m-barato",
    aiModelDefault: "m-caro",
    embeddingModel: null,
    embeddingDimensions: null,
  },
}));

const { ProviderRegistry, UnknownProviderError } = await import("./registry.js");
const { RoutingProvider } = await import("./routing-provider.js");
const { createAIProvider, createEmbeddingProvider, aiProviderRegistry, embeddingProviderRegistry } =
  await import("./factory.js");
const { formatProviderInfo, formatRunHeader } = await import("./describe-provider.js");

import type { CompletionOptions, DescribedAIProvider, ProviderInfo } from "./provider.js";

function fakeProvider(
  name: string,
  overrides: Partial<ProviderInfo["capabilities"]> = {}
): DescribedAIProvider & { calls: Array<{ prompt: string; tier?: string }> } {
  const calls: Array<{ prompt: string; tier?: string }> = [];
  return {
    calls,
    info: {
      name,
      capabilities: {
        structuredOutput: "native",
        usage: "exact",
        billing: "api",
        dataLeavesMachine: true,
        supportsThinking: true,
        ...overrides,
      },
    },
    async complete(prompt: string, opts: CompletionOptions = {}) {
      calls.push({ prompt, ...(opts.tier ? { tier: opts.tier } : {}) });
      return name;
    },
    async embed() {
      return [1];
    },
  };
}

const base = {
  aiProvider: "a",
  aiProviderCheap: null,
  aiProviderDefault: null,
  embeddingProvider: "voyage",
};

describe("ProviderRegistry", () => {
  it("crea el proveedor registrado por nombre", () => {
    const registry = new ProviderRegistry<DescribedAIProvider>("completions");
    registry.register("a", () => fakeProvider("a"));
    expect(registry.create("a").info.name).toBe("a");
  });

  it("falla explícito con un nombre desconocido y lista los disponibles", () => {
    const registry = new ProviderRegistry<DescribedAIProvider>("completions");
    registry.register("b", () => fakeProvider("b"));
    registry.register("a", () => fakeProvider("a"));
    expect(() => registry.create("zzz")).toThrow(UnknownProviderError);
    expect(() => registry.create("zzz")).toThrow(/zzz.*a, b/);
  });

  it("no permite registrar dos veces el mismo nombre", () => {
    const registry = new ProviderRegistry<DescribedAIProvider>("completions");
    registry.register("a", () => fakeProvider("a"));
    expect(() => registry.register("a", () => fakeProvider("a"))).toThrow(/ya está registrado/);
  });
});

describe("createAIProvider", () => {
  function registryWith(...names: string[]) {
    const registry = new ProviderRegistry<DescribedAIProvider>("completions");
    for (const name of names) registry.register(name, () => fakeProvider(name));
    return registry;
  }

  it("usa un único motor cuando no hay overrides por tier", () => {
    const provider = createAIProvider(base, registryWith("a"));
    expect(provider.info.name).toBe("a");
    expect(provider).not.toBeInstanceOf(RoutingProvider);
  });

  it("no enruta si los overrides apuntan al mismo motor", () => {
    const provider = createAIProvider(
      { ...base, aiProviderCheap: "b", aiProviderDefault: "b" },
      registryWith("a", "b")
    );
    expect(provider.info.name).toBe("b");
  });

  it("enruta por tier cuando los motores difieren", async () => {
    const provider = createAIProvider(
      { ...base, aiProviderCheap: "b" },
      registryWith("a", "b")
    );
    expect(provider).toBeInstanceOf(RoutingProvider);
    expect(await provider.complete("x", { tier: "cheap" })).toBe("b");
    expect(await provider.complete("x", { tier: "default" })).toBe("a");
    expect(await provider.complete("x")).toBe("a");
  });

  it("falla explícito si el motor configurado no existe", () => {
    expect(() => createAIProvider({ ...base, aiProvider: "nope" }, registryWith("a"))).toThrow(
      UnknownProviderError
    );
  });
});

describe("motores por defecto", () => {
  it("son nombres realmente registrados: un error de tipeo rompería el arranque de todos los CLIs", async () => {
    const { DEFAULT_AI_PROVIDER, DEFAULT_EMBEDDING_PROVIDER } = await import(
      "../../shared/provider-defaults.js"
    );
    expect(aiProviderRegistry.names()).toContain(DEFAULT_AI_PROVIDER);
    expect(embeddingProviderRegistry.names()).toContain(DEFAULT_EMBEDDING_PROVIDER);
  });

  it("completions por suscripción y embeddings en Voyage", async () => {
    const { DEFAULT_AI_PROVIDER, DEFAULT_EMBEDDING_PROVIDER } = await import(
      "../../shared/provider-defaults.js"
    );
    expect(DEFAULT_AI_PROVIDER).toBe("claude-code");
    expect(DEFAULT_EMBEDDING_PROVIDER).toBe("voyage");
  });
});

describe("registros incorporados", () => {
  it("anthropic-api y voyage son los motores por defecto actuales", () => {
    expect(aiProviderRegistry.names()).toContain("anthropic-api");
    expect(embeddingProviderRegistry.names()).toContain("voyage");
  });

  it("crea los motores actuales con su información declarada", () => {
    const ai = createAIProvider({ ...base, aiProvider: "anthropic-api" });
    expect(ai.info).toMatchObject({
      name: "anthropic-api",
      capabilities: { billing: "api", dataLeavesMachine: true, structuredOutput: "native" },
    });
    const embeddings = createEmbeddingProvider(base);
    expect(embeddings.info.name).toBe("voyage");
  });
});

describe("RoutingProvider.ensureReady", () => {
  it("chequea los dos motores y propaga el fallo de cualquiera", async () => {
    const ok = fakeProvider("a");
    const roto = { ...fakeProvider("b"), ensureReady: async () => { throw new Error("sin sesión"); } };
    const checked: string[] = [];
    const conChequeo = { ...ok, ensureReady: async () => void checked.push("a") };
    await expect(new RoutingProvider({ cheap: conChequeo, default: roto }).ensureReady()).rejects.toThrow("sin sesión");
    expect(checked).toEqual(["a"]);
  });

  it("no exige que los motores implementen el chequeo", async () => {
    await expect(
      new RoutingProvider({ cheap: fakeProvider("a"), default: fakeProvider("b") }).ensureReady()
    ).resolves.toBeUndefined();
  });
});

describe("RoutingProvider.info", () => {
  it("toma lo más conservador de los dos motores", () => {
    const local = fakeProvider("local", {
      billing: "local",
      dataLeavesMachine: false,
      structuredOutput: "prompt",
      usage: "none",
    });
    const cloud = fakeProvider("nube");
    const routing = new RoutingProvider({ cheap: local, default: cloud });
    expect(routing.info.capabilities).toMatchObject({
      billing: "api",
      dataLeavesMachine: true,
      structuredOutput: "prompt",
      usage: "none",
    });
    expect(routing.info.name).toBe("cheap=local, default=nube");
  });

  it("si ninguno saca los datos del equipo, el conjunto tampoco", () => {
    const a = fakeProvider("a", { billing: "local", dataLeavesMachine: false });
    const b = fakeProvider("b", { billing: "local", dataLeavesMachine: false });
    expect(new RoutingProvider({ cheap: a, default: b }).info.capabilities.dataLeavesMachine).toBe(false);
  });
});

describe("encabezado de corrida", () => {
  it("dice a dónde van los datos y qué se consume", () => {
    const text = formatProviderInfo(fakeProvider("claude-code", { billing: "subscription" }).info);
    expect(text).toContain("claude-code");
    expect(text).toContain("cuota de suscripción");
    expect(text).toContain("datos salen del equipo: sí");
  });

  it("muestra el perfil de dominio activo: sin él, dos corridas con perfiles distintos parecen comparables", () => {
    const header = formatRunHeader({ ai: fakeProvider("x").info, profile: { id: "generic", version: 1 } });
    expect(header).toContain("Perfil de dominio: generic@1");
  });

  it("omite las líneas que no aplican a la corrida", () => {
    const header = formatRunHeader({ ai: fakeProvider("x").info });
    expect(header).toMatch(/^IA: x/);
    expect(header).not.toContain("Embeddings");
  });
});
