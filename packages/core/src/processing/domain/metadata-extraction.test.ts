import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  extractEmojis,
  extractMentions,
  extractMetadata,
} from "./metadata-extraction.js";

describe("detectLanguage", () => {
  it("detecta español", () => {
    expect(detectLanguage("Hola, ¿como estas? Vale, nos vemos hoy")).toBe(
      "es"
    );
  });

  it("detecta francés", () => {
    expect(detectLanguage("Bonjour, comme tu vas? Merci pour cette semaine")).toBe(
      "fr"
    );
  });

  it("detecta inglés", () => {
    expect(detectLanguage("Hello, thanks for the update today")).toBe("en");
  });

  it("devuelve null para texto demasiado corto", () => {
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("")).toBeNull();
  });

  it("devuelve null si no matchea ninguna stopword conocida", () => {
    expect(detectLanguage("Xyzzy plugh foobar quux")).toBeNull();
  });
});

describe("extractEmojis", () => {
  it("extrae emojis en orden, con repetición", () => {
    expect(extractEmojis("Genial 😀 nos vemos 😀🎉")).toEqual([
      "😀",
      "😀",
      "🎉",
    ]);
  });

  it("devuelve vacío si no hay emojis", () => {
    expect(extractEmojis("Sin emojis aca")).toEqual([]);
  });
});

describe("extractMentions", () => {
  const participants = [
    { id: "p1", displayName: "Juan" },
    { id: "p2", displayName: "Maria Lopez" },
  ];

  it("detecta mención de un participante por nombre", () => {
    const result = extractMentions("Hable con Juan ayer", participants);
    expect(result.mentionedParticipantIds).toEqual(["p1"]);
  });

  it("no matchea substrings parciales (word boundary)", () => {
    const result = extractMentions("Juancito llamo", participants);
    expect(result.mentionedParticipantIds).toEqual([]);
  });

  it("detecta marcador @mención explícito que no es un participante conocido", () => {
    const result = extractMentions("cc @Pedro para coordinar", participants);
    expect(result.mentionedRawNames).toEqual(["Pedro"]);
    expect(result.mentionedParticipantIds).toEqual([]);
  });

  it("no duplica en mentionedRawNames si el @mención sí es un participante", () => {
    const result = extractMentions("@Juan confirmalo", participants);
    expect(result.mentionedParticipantIds).toEqual(["p1"]);
    expect(result.mentionedRawNames).toEqual([]);
  });

  it("detecta un participante cuyo nombre empieza o termina en letra acentuada", () => {
    const withAccents = [
      { id: "p3", displayName: "Ángela" },
      { id: "p4", displayName: "Óscar" },
    ];
    expect(
      extractMentions("Ángela va a venir", withAccents).mentionedParticipantIds
    ).toEqual(["p3"]);
    expect(
      extractMentions("avisale a Óscar", withAccents).mentionedParticipantIds
    ).toEqual(["p4"]);
  });
});

describe("extractMetadata", () => {
  const participants = [{ id: "p1", displayName: "Juan" }];

  it("mensajes kind != text quedan vacíos pero definidos", () => {
    const result = extractMetadata(
      { content: "Llamada perdida", kind: "call" },
      participants
    );
    expect(result).toEqual({
      language: null,
      emojis: [],
      emojiCount: 0,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    });
  });

  it("compone idioma/emojis/menciones para un mensaje de texto real", () => {
    const result = extractMetadata(
      { content: "Hola Juan, vale, nos vemos 😀 el sabado", kind: "text" },
      participants
    );
    expect(result.language).toBe("es");
    expect(result.emojis).toEqual(["😀"]);
    expect(result.emojiCount).toBe(1);
    expect(result.mentionedParticipantIds).toEqual(["p1"]);
    expect(result.mentionedRawNames).toEqual([]);
  });
});
