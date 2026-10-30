import { describe, expect, it } from "vitest";
import { coerceModelArrayField } from "./model-json.js";

describe("coerceModelArrayField", () => {
  it("devuelve el array cuando la forma es la correcta", () => {
    expect(coerceModelArrayField({ events: [1, 2] }, "events")).toEqual([1, 2]);
  });

  it("desenvuelve el objeto entero re-codificado como string", () => {
    // Forma exacta observada contra la API real (Sonnet 5, smoke test del
    // 2026-08-03): el campo trae un string con todo el JSON otra vez.
    const observado = {
      events: JSON.stringify({ events: [{ type: "propuesta" }] }),
    };
    expect(coerceModelArrayField(observado, "events")).toEqual([
      { type: "propuesta" },
    ]);
  });

  it("desenvuelve un string que contiene directamente el array", () => {
    expect(coerceModelArrayField({ events: "[1,2]" }, "events")).toEqual([1, 2]);
  });

  it("devuelve null si el string no es JSON", () => {
    expect(coerceModelArrayField({ events: "no es json" }, "events")).toBeNull();
  });

  it("devuelve null si el campo no existe", () => {
    expect(coerceModelArrayField({ otra: [1] }, "events")).toBeNull();
  });

  it("devuelve null si el valor no es ni array ni string", () => {
    expect(coerceModelArrayField({ events: 42 }, "events")).toBeNull();
    expect(coerceModelArrayField({ events: null }, "events")).toBeNull();
  });

  it("devuelve null si el string envuelve algo que no es un array", () => {
    expect(coerceModelArrayField({ events: '{"events": "otra vez texto"}' }, "events")).toBeNull();
  });

  it("devuelve null si el contenedor no es un objeto", () => {
    expect(coerceModelArrayField(null, "events")).toBeNull();
    expect(coerceModelArrayField("texto", "events")).toBeNull();
  });
});
