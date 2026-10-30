// Un perfil mal formado cambia los prompts y los enums del esquema forzado
// sin que nadie lo note: la validación tiene que abortar, no corregir.
// Fixtures inventados (rules/ai-cost.md: sin API real).

import { describe, expect, it } from "vitest";
import {
  InvalidDomainProfileError,
  parseDomainProfile,
  withProfileVersion,
} from "./domain-profile.js";
import { GENERIC_PROFILE } from "./generic-profile.js";
import { buildEventDetectionJsonSchema, buildEventDetectionPrompt, parseEventDetectionResponse } from "../knowledge/domain/event-detection.js";
import { buildIntentDetectionPrompt } from "../assistant/domain/intent-detection.js";

const clubProfile = {
  id: "club-deportivo",
  version: 3,
  conversationContext: "un grupo de WhatsApp de un club deportivo",
  caseCategories: ["entrenamientos", "torneos", "cuotas", "otro"],
  catchAllCategory: "otro",
  analysisDimensions: ["cordialidad", "urgencia"],
  caseContinuityDays: 21,
  catchAllContinuityDays: 5,
  intentExamples: [{ question: "¿qué se dijo sobre el torneo?", text: "torneo" }],
};

describe("parseDomainProfile", () => {
  it("acepta un perfil válido", () => {
    expect(parseDomainProfile(clubProfile)).toEqual(clubProfile);
  });

  it("el perfil genérico incluido en el código también es válido", () => {
    expect(parseDomainProfile(GENERIC_PROFILE)).toEqual(GENERIC_PROFILE);
  });

  it.each([
    ["no es un objeto", "texto"],
    ["catchAllCategory fuera de caseCategories", { ...clubProfile, catchAllCategory: "nada" }],
    ["categorías repetidas", { ...clubProfile, caseCategories: ["otro", "otro"] }],
    ["sin categorías", { ...clubProfile, caseCategories: [] }],
    ["categoría vacía", { ...clubProfile, caseCategories: ["otro", "  "] }],
    ["días de continuidad no positivos", { ...clubProfile, caseContinuityDays: 0 }],
    ["versión no entera", { ...clubProfile, version: 1.5 }],
    ["sin ejemplos de intent", { ...clubProfile, intentExamples: [] }],
    ["ejemplo de intent sin texto ancla", { ...clubProfile, intentExamples: [{ question: "¿x?" }] }],
    ["contexto vacío", { ...clubProfile, conversationContext: "" }],
  ])("rechaza un perfil inválido: %s", (_nombre, raw) => {
    expect(() => parseDomainProfile(raw)).toThrow(InvalidDomainProfileError);
  });
});

describe("withProfileVersion", () => {
  it("incluye id y versión del perfil en la versión del prompt", () => {
    expect(withProfileVersion("event-detection-v2", GENERIC_PROFILE)).toBe(
      "event-detection-v2+generic@1"
    );
  });
});

describe("el perfil gobierna los prompts y la validación", () => {
  const profile = parseDomainProfile(clubProfile);
  const window = [
    { index: 1, speakerLabel: "Participante 1", sentAt: new Date("2025-03-10T09:00:00Z"), content: "¿entrenamos el jueves?" },
  ];

  it("Event Detection inyecta contexto, categorías y dimensiones del perfil", () => {
    const prompt = buildEventDetectionPrompt(window, profile);
    expect(prompt).toContain("un grupo de WhatsApp de un club deportivo");
    expect(prompt).toContain("entrenamientos, torneos, cuotas, otro.");
    expect(prompt).toContain("cordialidad, urgencia.");
    expect(prompt).not.toContain("planes, trabajo");
  });

  it("el esquema forzado usa los enums del perfil", () => {
    const schema = buildEventDetectionJsonSchema(profile);
    expect(schema.properties.events.items.properties.category.enum).toEqual(profile.caseCategories);
  });

  it("descarta un evento cuya categoría no pertenece al perfil activo", () => {
    const raw = JSON.stringify({
      events: [
        { type: "propuesta", category: "planes", title: "t", message_indices: [1], observation: "o", confidence: 0.9 },
        { type: "propuesta", category: "torneos", title: "t", message_indices: [1], observation: "o", confidence: 0.9 },
      ],
    });
    const events = parseEventDetectionResponse(raw, [1], profile);
    expect(events.map((e) => e.category)).toEqual(["torneos"]);
  });

  it("Intent Detection usa los ejemplos y categorías del perfil", () => {
    const prompt = buildIntentDetectionPrompt("¿x?", new Date("2025-06-15T00:00:00Z"), profile);
    expect(prompt).toContain('"¿qué se dijo sobre el torneo?" → text="torneo"');
    expect(prompt).toContain("(categorías: entrenamientos, torneos, cuotas, otro)");
  });
});
