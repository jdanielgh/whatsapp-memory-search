// Sin llamadas a la API real (rules/ai-cost.md): fixtures inventados.

import { describe, expect, it } from "vitest";
import { GENERIC_PROFILE } from "../../shared/generic-profile.js";
import {
  InvalidIntentResponseError,
  buildIntentDetectionPrompt,
  parseIntentDetectionResponse,
} from "./intent-detection.js";

const hoy = new Date("2025-06-15T00:00:00Z");

describe("buildIntentDetectionPrompt", () => {
  it("incluye la pregunta y la fecha de hoy para resolver expresiones relativas", () => {
    const prompt = buildIntentDetectionPrompt("¿qué pasó la semana pasada?", hoy, GENERIC_PROFILE);
    expect(prompt).toContain("¿qué pasó la semana pasada?");
    expect(prompt).toContain("2025-06-15");
  });

  it("instruye a no inventar fechas que la pregunta no menciona", () => {
    expect(buildIntentDetectionPrompt("x", hoy, GENERIC_PROFILE)).toContain("No inventes fechas");
  });

  it("instruye a usar buscar_por_tema para preguntas por significado, no no_soportado", () => {
    // SI-036: la búsqueda semántica no reemplaza a la literal, pero
    // tampoco al revés — una pregunta por significado ya no cae en
    // "no puedo responder" ahora que Semantic Search (Q-SEM-01) existe.
    const prompt = buildIntentDetectionPrompt("¿de qué hablamos relacionado con X?", hoy, GENERIC_PROFILE);
    expect(prompt).toContain("buscar_por_tema");
    expect(prompt).toContain("SIGNIFICADO");
  });
});

describe("parseIntentDetectionResponse", () => {
  it("parsea un intent con sus parámetros", () => {
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({ intent: "buscar_por_texto", text: "viaje" })
    );
    expect(parsed.intent).toBe("buscar_por_texto");
    expect(parsed.text).toBe("viaje");
    expect(parsed.date).toBeNull();
  });

  it("rechaza un intent fuera del enum", () => {
    expect(() =>
      parseIntentDetectionResponse(JSON.stringify({ intent: "hacer_magia" }))
    ).toThrow(InvalidIntentResponseError);
  });

  it("rechaza JSON inválido", () => {
    expect(() => parseIntentDetectionResponse("no es json")).toThrow(
      InvalidIntentResponseError
    );
  });

  it("descarta fechas con formato equivocado en vez de propagarlas", () => {
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({ intent: "buscar_por_fecha", date: "12 de marzo" })
    );
    // Una fecha ilegible no debe convertirse en un rango silenciosamente
    // equivocado río abajo.
    expect(parsed.date).toBeNull();
  });

  it("descarta una fecha con formato correcto pero inexistente", () => {
    // `new Date("2025-02-31")` no falla: rueda al 3 de marzo. Sin la
    // comprobación de ida y vuelta, la consulta buscaría en un día que el
    // usuario nunca pidió.
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({ intent: "buscar_por_fecha", date: "2025-02-31" })
    );
    expect(parsed.date).toBeNull();
  });

  it("acepta una fecha real", () => {
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({ intent: "buscar_por_fecha", date: "2025-02-28" })
    );
    expect(parsed.date).toBe("2025-02-28");
  });

  it("normaliza cadenas vacías a null", () => {
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({ intent: "estadisticas", text: "   " })
    );
    expect(parsed.text).toBeNull();
  });

  it("conserva la razón cuando el intent no está soportado", () => {
    const parsed = parseIntentDetectionResponse(
      JSON.stringify({
        intent: "no_soportado",
        reason: "requiere entender el significado, no solo las palabras",
      })
    );
    expect(parsed.reason).toContain("significado");
  });
});
