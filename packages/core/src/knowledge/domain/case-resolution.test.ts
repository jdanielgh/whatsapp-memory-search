// Case Resolution es, según plans/, "la pieza
// con más ambigüedad de todo el pipeline". Estos tests fijan el criterio
// elegido para que un cambio de comportamiento sea deliberado y no un
// efecto colateral.

import { describe, expect, it } from "vitest";
import { GENERIC_PROFILE } from "../../shared/generic-profile.js";
import { resolveCase, type OpenCaseSummary } from "./case-resolution.js";

const CASE_CONTINUITY_DAYS = GENERIC_PROFILE.caseContinuityDays;

function resolve(
  event: Parameters<typeof resolveCase>[0],
  openCases: readonly OpenCaseSummary[]
) {
  return resolveCase(event, openCases, GENERIC_PROFILE);
}

const marzo = new Date("2025-03-10T09:00:00Z");

function openCase(overrides: Partial<OpenCaseSummary> = {}): OpenCaseSummary {
  return {
    id: overrides.id ?? "caso-1",
    title: overrides.title ?? "plan de reuniones de marzo",
    category: overrides.category ?? "planes",
    // `??` no sirve acá: un `lastEventAt: null` explícito (Case sin
    // eventos) es un caso que hay que poder construir, y `??` lo
    // reemplazaría por el default.
    lastEventAt: "lastEventAt" in overrides ? overrides.lastEventAt ?? null : marzo,
  };
}

const evento = {
  category: "planes" as const,
  title: "recogida del sábado",
  occurredAt: marzo,
};

describe("resolveCase", () => {
  it("abre un Case nuevo cuando no hay ninguno de esa categoría", () => {
    const resolution = resolve(evento, [openCase({ category: "trabajo" })]);
    expect(resolution).toEqual({
      kind: "new",
      title: "recogida del sábado",
      category: "planes",
    });
  });

  it("abre un Case nuevo cuando no hay ninguno abierto", () => {
    expect(resolve(evento, []).kind).toBe("new");
  });

  it("agrupa con un Case de la misma categoría con actividad reciente", () => {
    const resolution = resolve(evento, [openCase({ id: "caso-planes" })]);
    expect(resolution).toEqual({ kind: "existing", caseId: "caso-planes" });
  });

  it("no agrupa con un Case de la misma categoría inactivo hace demasiado", () => {
    const viejo = new Date(marzo.getTime() - (CASE_CONTINUITY_DAYS + 10) * 86_400_000);
    const resolution = resolve(evento, [openCase({ lastEventAt: viejo })]);
    expect(resolution.kind).toBe("new");
  });

  it("prioriza el solapamiento de título sobre la cercanía temporal", () => {
    // Dos asuntos distintos de la misma categoría pueden convivir en el
    // tiempo; el título es la señal más específica de que hablan de lo
    // mismo.
    const viejoPeroDelTema = new Date(
      marzo.getTime() - (CASE_CONTINUITY_DAYS + 30) * 86_400_000
    );
    const resolution = resolve(
      { category: "viajes", title: "vacaciones de verano en la playa", occurredAt: marzo },
      [
        openCase({
          id: "verano",
          category: "viajes",
          title: "plan de vacaciones de verano",
          lastEventAt: viejoPeroDelTema,
        }),
        openCase({
          id: "navidad",
          category: "viajes",
          title: "vacaciones de Navidad",
          lastEventAt: marzo,
        }),
      ]
    );
    expect(resolution).toEqual({ kind: "existing", caseId: "verano" });
  });

  it("ignora tildes al comparar títulos", () => {
    const resolution = resolve(
      { category: "finanzas", title: "facturación mensual atrasada", occurredAt: marzo },
      [
        openCase({
          id: "factura",
          category: "finanzas",
          title: "facturacion mensual vencida",
          lastEventAt: new Date(marzo.getTime() - 200 * 86_400_000),
        }),
      ]
    );
    expect(resolution).toEqual({ kind: "existing", caseId: "factura" });
  });

  it("no agrupa por una sola palabra significativa en común", () => {
    // Un solo término compartido es demasiado débil: "trabajo" aparece
    // en casi cualquier título de esa categoría.
    const viejo = new Date(marzo.getTime() - (CASE_CONTINUITY_DAYS + 5) * 86_400_000);
    const resolution = resolve(
      { category: "trabajo", title: "reunión oficina tutoría", occurredAt: marzo },
      [openCase({ id: "c", category: "trabajo", title: "matrícula oficina nueva", lastEventAt: viejo })]
    );
    expect(resolution.kind).toBe("new");
  });

  it("ante varios candidatos por cercanía, elige el de actividad más reciente", () => {
    const resolution = resolve(evento, [
      openCase({ id: "viejo", title: "asunto a", lastEventAt: new Date("2025-02-20T00:00:00Z") }),
      openCase({ id: "reciente", title: "asunto b", lastEventAt: new Date("2025-03-09T00:00:00Z") }),
    ]);
    expect(resolution).toEqual({ kind: "existing", caseId: "reciente" });
  });

  it("no agrupa con un Case sin eventos por cercanía temporal", () => {
    // lastEventAt null significa "todavía sin actividad": no hay
    // proximidad que medir.
    const resolution = resolve(evento, [
      openCase({ id: "vacio", title: "sin relación alguna", lastEventAt: null }),
    ]);
    expect(resolution.kind).toBe("new");
  });
});

describe("resolveCase — la categoría de descarte usa una ventana más corta", () => {
  it("no arrastra a un Case 'otro' con actividad de hace semanas", () => {
    // Medido sobre datos reales: con la ventana normal de 45 días, un solo
    // Case "otro" absorbió el 41% de los eventos a lo largo de más de un año,
    // porque cada evento nuevo le refrescaba la fecha y lo mantenía vivo.
    const haceTresSemanas = new Date(marzo.getTime() - 21 * 86_400_000);
    const resolution = resolve(
      { category: "otro", title: "aviso de mudanza", occurredAt: marzo },
      [
        openCase({
          id: "cajon",
          category: "otro",
          title: "pago del gimnasio",
          lastEventAt: haceTresSemanas,
        }),
      ]
    );
    expect(resolution.kind).toBe("new");
  });

  it("pero sí agrupa un intercambio puntual de los últimos días", () => {
    // Quitarle la cercanía por completo cambiaría un modo de fallo por el
    // contrario: cientos de Cases de un solo evento.
    const anteayer = new Date(marzo.getTime() - 2 * 86_400_000);
    const resolution = resolve(
      { category: "otro", title: "aviso de mudanza", occurredAt: marzo },
      [
        openCase({
          id: "recientes",
          category: "otro",
          title: "pago del gimnasio",
          lastEventAt: anteayer,
        }),
      ]
    );
    expect(resolution).toEqual({ kind: "existing", caseId: "recientes" });
  });

  it("pero sí agrupa dos eventos 'otro' que hablan del mismo asunto", () => {
    // El título sigue siendo señal válida: es específica de "esto es lo
    // mismo", no un mero "no sé dónde ponerlo".
    const resolution = resolve(
      { category: "otro", title: "pago del gimnasio mensual", occurredAt: marzo },
      [openCase({ id: "gim", category: "otro", title: "pago del gimnasio", lastEventAt: marzo })]
    );
    expect(resolution).toEqual({ kind: "existing", caseId: "gim" });
  });

  it("las demás categorías siguen agrupando por cercanía", () => {
    const resolution = resolve(
      { category: "salud", title: "cita con el dentista", occurredAt: marzo },
      [openCase({ id: "s", category: "salud", title: "revisión anual", lastEventAt: marzo })]
    );
    expect(resolution).toEqual({ kind: "existing", caseId: "s" });
  });
});
