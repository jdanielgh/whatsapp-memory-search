import { describe, expect, it } from "vitest";
import { parseParticipantRoles } from "./participant-roles.js";

describe("parseParticipantRoles", () => {
  it("parsea pares nombre=rol separados por coma", () => {
    expect(parseParticipantRoles("Ana=organizadora,Luis=miembro")).toEqual({
      Ana: "organizadora",
      Luis: "miembro",
    });
  });

  it("recorta espacios alrededor de nombre y rol", () => {
    expect(parseParticipantRoles(" Ana = organizadora , Luis = miembro ")).toEqual({
      Ana: "organizadora",
      Luis: "miembro",
    });
  });

  it("rechaza un par sin '='", () => {
    expect(() => parseParticipantRoles("Ana=organizadora,Luis")).toThrow(/mal formado/);
  });

  it("rechaza un par con nombre o rol vacío", () => {
    expect(() => parseParticipantRoles("=organizadora")).toThrow(/mal formado/);
    expect(() => parseParticipantRoles("Ana=")).toThrow(/mal formado/);
  });
});
