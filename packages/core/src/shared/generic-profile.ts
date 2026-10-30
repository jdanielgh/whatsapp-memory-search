// Perfil por defecto: sin ningún supuesto sobre el tema de la conversación.
// Un uso especializado se define en un archivo local (ver
// `profiles/example.json` y `domain-profile-loader.ts`), no se edita acá.

import type { DomainProfile } from "./domain-profile.js";

export const GENERIC_PROFILE: DomainProfile = {
  id: "generic",
  version: 1,
  conversationContext: "una conversación de WhatsApp entre dos o más personas",
  caseCategories: ["planes", "trabajo", "finanzas", "salud", "viajes", "otro"],
  catchAllCategory: "otro",
  analysisDimensions: ["formalidad", "cordialidad", "tensión", "cooperación"],
  caseContinuityDays: 30,
  catchAllContinuityDays: 7,
  intentExamples: [
    { question: "¿qué se dijo sobre el viaje?", text: "viaje" },
    { question: "¿hablamos del presupuesto?", text: "presupuesto" },
  ],
};
