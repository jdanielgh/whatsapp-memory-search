// Tests obligatorios (rules/dev-style.md regla 4: recuperación RAG). Sin
// IA ni base de datos — lógica pura. Fixtures inventados
// (rules/agents-and-context.md).

import { describe, expect, it } from "vitest";
import { buildEmbeddingChunkText, type ChunkMessage } from "./embedding-chunking.js";

function msg(participantId: string, content: string): ChunkMessage {
  return { id: `${participantId}-${content}`, participantId, content };
}

describe("buildEmbeddingChunkText", () => {
  it("sin contexto previo, el chunk es solo el mensaje ancla etiquetado", () => {
    const text = buildEmbeddingChunkText(msg("ana", "hola"), []);
    expect(text).toBe("Participante 1: hola");
  });

  it("concatena el contexto previo antes del ancla, en orden cronológico", () => {
    const text = buildEmbeddingChunkText(msg("ana", "dale"), [
      msg("luis", "te va bien el sábado?"),
      msg("ana", "sí, a qué hora"),
    ]);
    expect(text).toBe(
      "Participante 1: te va bien el sábado?\n" +
        "Participante 2: sí, a qué hora\n" +
        "Participante 2: dale"
    );
  });

  it("etiqueta a cada participante consistentemente por orden de primera aparición en el chunk", () => {
    const text = buildEmbeddingChunkText(msg("luis", "ok"), [
      msg("luis", "hola"),
      msg("ana", "hola"),
    ]);
    // luis aparece primero => Participante 1; ana => Participante 2.
    expect(text).toBe(
      "Participante 1: hola\nParticipante 2: hola\nParticipante 1: ok"
    );
  });

  it("nunca incluye el nombre real del participante (rules/security-privacy.md)", () => {
    const text = buildEmbeddingChunkText(msg("id-de-ana-real", "hola"), []);
    expect(text).not.toContain("id-de-ana-real");
  });

  it("respeta el orden del array de contexto tal cual llega, no lo reordena", () => {
    // El caller es responsable de pasarlo ya ordenado cronológicamente —
    // esta función no reordena por su cuenta.
    const text = buildEmbeddingChunkText(msg("ana", "tres"), [
      msg("ana", "uno"),
      msg("ana", "dos"),
    ]);
    expect(text).toBe("Participante 1: uno\nParticipante 1: dos\nParticipante 1: tres");
  });
});
