// Tests obligatorios de whatsapp-ingest (rules/dev-style.md). Todos los
// fixtures son texto inventado que imita el formato real documentado en
// docs/DECISIONS.md — nunca un extracto real de la conversación
// (rules/agents-and-context.md, rules/security-privacy.md).

import { describe, expect, it } from "vitest";
import { parseWhatsAppExport } from "./whatsapp-parser.js";

const NBSP = " "; // espacio angosto de no separación (antes: espacio normal por error)
const LRM = "‎"; // U+200E

const DEFAULT_OPTS = {
  timeZone: { kind: "fixed", utcOffsetMinutes: 0 } as const,
  dateFormat: "dmy" as const,
};

function line(
  date: string,
  time: string,
  meridiem: "a.m." | "p.m.",
  rest: string
): string {
  return `[${date}, ${time}${NBSP}${meridiem}] ${rest}`;
}

describe("parseWhatsAppExport", () => {
  it("parsea un mensaje de texto simple con remitente", () => {
    const raw = line("01/02/24", "10:15:00", "a.m.", "Ana: Hola, ¿cómo estás?");
    const { messages, warnings } = parseWhatsAppExport(raw, {
      ...DEFAULT_OPTS,
      timeZone: { kind: "fixed", utcOffsetMinutes: -300 },
    });

    expect(warnings).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      displayName: "Ana",
      content: "Hola, ¿cómo estás?",
      kind: "text",
      deletedBySender: false,
      attachment: null,
    });
  });

  it("respeta el offset UTC explícito (huso horario ambiguo)", () => {
    const raw = line("01/02/24", "10:00:00", "a.m.", "Ana: ping");

    const asUtcMinus5 = parseWhatsAppExport(raw, {
      ...DEFAULT_OPTS,
      timeZone: { kind: "fixed", utcOffsetMinutes: -300 },
    });
    const asUtcPlus0 = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(asUtcMinus5.messages[0]!.sentAt.toISOString()).toBe(
      "2024-02-01T15:00:00.000Z"
    );
    expect(asUtcPlus0.messages[0]!.sentAt.toISOString()).toBe(
      "2024-02-01T10:00:00.000Z"
    );
    expect(asUtcMinus5.messages[0]!.sentAt.getTime()).not.toBe(
      asUtcPlus0.messages[0]!.sentAt.getTime()
    );
  });

  it("concatena líneas de continuación de un mensaje multilínea", () => {
    const raw = [
      line("01/02/24", "10:15:00", "a.m.", "Ana: Primera línea"),
      "segunda línea sin prefijo",
      "tercera línea también sin prefijo",
    ].join("\n");

    const { messages } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe(
      "Primera línea\nsegunda línea sin prefijo\ntercera línea también sin prefijo"
    );
  });

  it("maneja terminadores de línea mixtos (CRLF + LF)", () => {
    const raw =
      line("01/02/24", "09:00:00", "a.m.", "Ana: mensaje uno") +
      "\r\n" +
      line("01/02/24", "09:01:00", "a.m.", "Beto: mensaje dos") +
      "\n" +
      line("01/02/24", "09:02:00", "a.m.", "Ana: mensaje tres");

    const { messages, warnings } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(warnings).toHaveLength(0);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.content)).toEqual([
      "mensaje uno",
      "mensaje dos",
      "mensaje tres",
    ]);
  });

  it("marca adjuntos sin archivo real como unavailable, por tipo", () => {
    const cases: Array<[string, "imagen" | "audio" | "video" | "documento" | "sticker"]> =
      [
        [`${LRM}imagen omitida`, "imagen"],
        [`${LRM}audio omitido`, "audio"],
        [`${LRM}Video omitido`, "video"], // mayúscula inconsistente, ver docs/DECISIONS.md
        [`${LRM}documento omitido`, "documento"],
        [`${LRM}sticker omitido`, "sticker"],
      ];

    for (const [placeholder, expectedType] of cases) {
      const raw = line("01/02/24", "10:00:00", "a.m.", `Ana: ${placeholder}`);
      const { messages } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

      expect(messages[0]!.attachment).toEqual({
        type: expectedType,
        status: "unavailable",
      });
      expect(messages[0]!.kind).toBe("text");
      expect(messages[0]!.content).not.toContain(LRM);
    }
  });

  it("marca mensajes eliminados con deletedBySender y conserva el placeholder", () => {
    const raw = line(
      "01/02/24",
      "10:00:00",
      "a.m.",
      "Ana: Se eliminó este mensaje"
    );
    const { messages } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(messages[0]).toMatchObject({
      deletedBySender: true,
      kind: "text",
      content: "Se eliminó este mensaje",
    });
  });

  it("clasifica eventos de llamada como kind='call', no 'text'", () => {
    const raw = [
      line("01/02/24", "10:00:00", "a.m.", `Ana: ${LRM}Llamada perdida`),
      line("01/02/24", "10:05:00", "a.m.", `Beto: ${LRM}Videollamada`),
    ].join("\n");

    const { messages } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(messages.map((m) => m.kind)).toEqual(["call", "call"]);
  });

  it("clasifica un encabezado sin remitente como mensaje de sistema", () => {
    const raw = line(
      "01/02/24",
      "08:00:00",
      "a.m.",
      `${LRM}Los mensajes y las llamadas están cifrados de extremo a extremo.`
    );
    const { messages, warnings } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(warnings).toHaveLength(0);
    expect(messages[0]).toMatchObject({
      displayName: null,
      kind: "system",
      deletedBySender: false,
      attachment: null,
    });
  });

  it("reporta un warning si una línea de continuación aparece sin mensaje abierto", () => {
    const raw = "línea huérfana sin encabezado previo";
    const { messages, warnings } = parseWhatsAppExport(raw, { ...DEFAULT_OPTS });

    expect(messages).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.lineNumber).toBe(1);
  });

  describe("timeZone: eu-cet-cest (Europa central)", () => {
    it("usa CET (UTC+1) en horario de invierno", () => {
      const raw = line("15/01/24", "10:00:00", "a.m.", "Ana: hola de invierno");
      const { messages } = parseWhatsAppExport(raw, {
        dateFormat: "dmy",
        timeZone: { kind: "eu-cet-cest" },
      });

      expect(messages[0]!.sentAt.toISOString()).toBe("2024-01-15T09:00:00.000Z");
    });

    it("usa CEST (UTC+2) en horario de verano", () => {
      const raw = line("15/07/24", "10:00:00", "a.m.", "Ana: hola de verano");
      const { messages } = parseWhatsAppExport(raw, {
        dateFormat: "dmy",
        timeZone: { kind: "eu-cet-cest" },
      });

      expect(messages[0]!.sentAt.toISOString()).toBe("2024-07-15T08:00:00.000Z");
    });

    it("cruza correctamente la transición de marzo (CET -> CEST)", () => {
      // 2024: el cambio a horario de verano fue el domingo 31 de marzo.
      const beforeChange = line("30/03/24", "10:00:00", "a.m.", "Ana: antes del cambio");
      const afterChange = line("31/03/24", "10:00:00", "a.m.", "Ana: después del cambio");
      const opts = { dateFormat: "dmy" as const, timeZone: { kind: "eu-cet-cest" as const } };

      expect(
        parseWhatsAppExport(beforeChange, opts).messages[0]!.sentAt.toISOString()
      ).toBe("2024-03-30T09:00:00.000Z"); // todavía CET (+1)
      expect(
        parseWhatsAppExport(afterChange, opts).messages[0]!.sentAt.toISOString()
      ).toBe("2024-03-31T08:00:00.000Z"); // ya CEST (+2)
    });

    it("cruza correctamente la transición de octubre (CEST -> CET)", () => {
      // 2024: el cambio a horario de invierno fue el domingo 27 de octubre.
      const beforeChange = line("26/10/24", "10:00:00", "a.m.", "Ana: antes del cambio");
      const afterChange = line("27/10/24", "10:00:00", "a.m.", "Ana: después del cambio");
      const opts = { dateFormat: "dmy" as const, timeZone: { kind: "eu-cet-cest" as const } };

      expect(
        parseWhatsAppExport(beforeChange, opts).messages[0]!.sentAt.toISOString()
      ).toBe("2024-10-26T08:00:00.000Z"); // todavía CEST (+2)
      expect(
        parseWhatsAppExport(afterChange, opts).messages[0]!.sentAt.toISOString()
      ).toBe("2024-10-27T09:00:00.000Z"); // ya CET (+1)
    });
  });
});
