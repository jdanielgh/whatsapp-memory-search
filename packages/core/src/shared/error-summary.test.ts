import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { errorSummary } from "./error-summary.js";

describe("errorSummary", () => {
  it("devuelve el mensaje de un Error sin causa", () => {
    expect(errorSummary(new Error("algo falló"))).toBe("algo falló");
  });

  it("convierte a string lo que no es Error", () => {
    expect(errorSummary("texto")).toBe("texto");
    expect(errorSummary(42)).toBe("42");
  });

  it("no filtra los parámetros de un DrizzleQueryError, solo la causa del driver", () => {
    const err = new DrizzleQueryError(
      "insert into messages (content) values ($1)",
      ["contenido inventado de prueba"],
      new Error("permission denied for table messages")
    );

    const summary = errorSummary(err);

    expect(summary).toBe("permission denied for table messages");
    expect(summary).not.toContain("contenido inventado");
  });

  it("baja hasta la causa más interna", () => {
    const err = new Error("externo", {
      cause: new Error("medio", { cause: new Error("interno") }),
    });
    expect(errorSummary(err)).toBe("interno");
  });
});
