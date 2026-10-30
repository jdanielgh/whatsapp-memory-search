// La auditoría de una corrida dice qué motor produjo lo derivado y a dónde
// fueron los datos. Un registro que falte o que enmascare el error de la
// corrida deja una interpretación sin origen. Sin base de datos: el
// registrador es un fake.

import { describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../infrastructure/ai/provider.js";
import type { AuditEntry } from "./audit.js";
import { GENERIC_PROFILE } from "./generic-profile.js";
import { auditedRun, describeRunForAudit } from "./run-audit.js";

const subscription: ProviderInfo = {
  name: "claude-code",
  capabilities: {
    structuredOutput: "native",
    usage: "exact",
    billing: "subscription",
    dataLeavesMachine: true,
    supportsThinking: true,
  },
};

function recorder() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: async (entry: AuditEntry) => {
      entries.push(entry);
    },
  };
}

const failingRecord = async () => {
  throw new Error("base caída");
};

function options(record: (entry: AuditEntry) => Promise<void>) {
  return {
    actor: "cli-prueba",
    operation: "pipeline_run",
    conversationId: "00000000-0000-0000-0000-000000000001",
    info: { ai: subscription, profile: GENERIC_PROFILE },
    record,
  };
}

describe("describeRunForAudit", () => {
  it("registra motor, facturación, salida de datos y perfil", () => {
    expect(describeRunForAudit({ ai: subscription, profile: GENERIC_PROFILE })).toEqual({
      ai: { provider: "claude-code", billing: "subscription", dataLeavesMachine: true },
      domainProfile: "generic@1",
    });
  });

  it("omite lo que no aplica a la corrida", () => {
    expect(describeRunForAudit({ embeddings: subscription })).toEqual({
      embeddings: { provider: "claude-code", billing: "subscription", dataLeavesMachine: true },
    });
  });
});

describe("auditedRun", () => {
  it("registra el éxito con el resumen de la corrida y devuelve su resultado", async () => {
    const { entries, record } = recorder();
    const result = await auditedRun(
      options(record),
      async () => ({ messagesProcessed: 20 }),
      (r) => ({ stage: "prueba", ...r })
    );
    expect(result).toEqual({ messagesProcessed: 20 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "cli-prueba",
      operation: "pipeline_run",
      resourceType: "Conversation",
      resourceId: "00000000-0000-0000-0000-000000000001",
      result: "success",
      details: {
        ai: { provider: "claude-code" },
        domainProfile: "generic@1",
        stage: "prueba",
        messagesProcessed: 20,
      },
    });
  });

  it("una corrida cortada por el motor queda registrada como fallo y el error se relanza", async () => {
    const { entries, record } = recorder();
    const run = async () => {
      throw new Error("límite de uso alcanzado");
    };
    await expect(auditedRun(options(record), run, () => ({}))).rejects.toThrow(
      "límite de uso alcanzado"
    );
    expect(entries[0]).toMatchObject({
      result: "failure",
      details: { errorSummary: "límite de uso alcanzado", ai: { billing: "subscription" } },
    });
  });

  it("si registrar el fallo también falla, no enmascara el error original", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = async () => {
      throw new Error("error de la corrida");
    };
    await expect(auditedRun(options(failingRecord), run, () => ({}))).rejects.toThrow(
      "error de la corrida"
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("un fallo al registrar el éxito no descarta el trabajo ya hecho", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await auditedRun(options(failingRecord), async () => "listo", () => ({}));
    expect(result).toBe("listo");
    warn.mockRestore();
  });

  it("recorta el resumen del error para no guardar texto largo", async () => {
    const { entries, record } = recorder();
    const run = async () => {
      throw new Error("x".repeat(1000));
    };
    await auditedRun(options(record), run, () => ({})).catch(() => {});
    expect((entries[0]?.details?.errorSummary as string).length).toBe(300);
  });
});
