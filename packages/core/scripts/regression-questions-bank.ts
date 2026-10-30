// Banco de 100 preguntas para la regresión de UC-014
// (scripts/regression-100-questions.ts).
//
// Las preguntas son GENÉRICAS a propósito: describen qué se busca, sin
// citar contenido real de la conversación ni nombres de terceros
// (rules/agents-and-context.md — los fixtures y entradas de prueba nunca
// reproducen el historial real). Que encuentren o no evidencia es
// justamente lo que la regresión mide.
//
// Las preguntas sobre Cases siguen las categorías del perfil genérico
// (`src/shared/generic-profile.ts`). Un banco adaptado a un uso concreto
// vive fuera del repo, junto a su perfil local, y se pasa con
// `--questions <archivo>`.
//
// `category` sirve para leer el resultado agregado por tipo de búsqueda,
// no se le pasa al modelo: el intent lo decide Intent Detection sola. Si
// la distribución de intents detectados se aleja mucho de las categorías
// de acá, eso es señal de un problema de clasificación — es una de las
// cosas que la regresión busca detectar.

export interface BankQuestion {
  n: number;
  category:
    | "texto"
    | "fecha"
    | "rango"
    | "cronologia"
    | "case"
    | "semantica"
    | "estadisticas";
  question: string;
}

export const QUESTIONS: BankQuestion[] = [
  // --- Búsqueda por texto literal (1-14) ---
  { n: 1, category: "texto", question: "¿Qué se dijo sobre el viaje?" },
  { n: 2, category: "texto", question: "¿Hay mensajes que mencionen a la contadora?" },
  { n: 3, category: "texto", question: "¿Qué mensajes hablan de las llaves?" },
  { n: 4, category: "texto", question: "¿Se mencionó algún cumpleaños?" },
  { n: 5, category: "texto", question: "¿Qué se dijo sobre la factura?" },
  { n: 6, category: "texto", question: "¿Hay mensajes sobre el dentista?" },
  { n: 7, category: "texto", question: "¿Qué se habló sobre la mudanza?" },
  { n: 8, category: "texto", question: "¿Se mencionó alguna reunión de equipo?" },
  { n: 9, category: "texto", question: "¿Qué mensajes contienen la palabra presupuesto?" },
  { n: 10, category: "texto", question: "¿Hay algo sobre el pasaporte?" },
  { n: 11, category: "texto", question: "¿Qué se dijo sobre algún fin de semana largo?" },
  { n: 12, category: "texto", question: "¿Se habló de alguna escapada de verano?" },
  { n: 13, category: "texto", question: "¿Qué mensajes mencionan las notas de la reunión?" },
  { n: 14, category: "texto", question: "¿Hay mensajes sobre algún seguro?" },

  // --- Fecha exacta (15-22) ---
  { n: 15, category: "fecha", question: "¿Qué se habló el 1 de enero de 2025?" },
  { n: 16, category: "fecha", question: "¿Qué mensajes hay del 24 de diciembre de 2025?" },
  { n: 17, category: "fecha", question: "¿Qué se dijo el 14 de febrero de 2025?" },
  { n: 18, category: "fecha", question: "¿Qué pasó el 1 de mayo de 2025?" },
  { n: 19, category: "fecha", question: "¿Qué se habló ayer?" },
  { n: 20, category: "fecha", question: "¿Qué mensajes hay de hace exactamente una semana?" },
  { n: 21, category: "fecha", question: "¿Qué se dijo el 31 de diciembre de 2025?" },
  { n: 22, category: "fecha", question: "¿Qué pasó el 15 de agosto de 2025?" },

  // --- Rango de fechas (23-30) ---
  { n: 23, category: "rango", question: "¿Qué se habló entre el 1 y el 15 de marzo de 2025?" },
  { n: 24, category: "rango", question: "¿Qué pasó la primera semana de enero de 2025?" },
  { n: 25, category: "rango", question: "¿Qué se dijo durante julio de 2025?" },
  { n: 26, category: "rango", question: "¿Qué mensajes hay de todo diciembre de 2025?" },
  { n: 27, category: "rango", question: "¿Qué se habló entre Navidad y Año Nuevo?" },
  { n: 28, category: "rango", question: "¿Qué pasó en la última quincena del mes pasado?" },
  { n: 29, category: "rango", question: "¿Qué se dijo durante Semana Santa?" },
  { n: 30, category: "rango", question: "¿Qué mensajes hay del segundo semestre de 2025?" },

  // --- Cronología (31-38) ---
  { n: 31, category: "cronologia", question: "¿Qué pasó la semana pasada?" },
  { n: 32, category: "cronologia", question: "¿Qué pasó el mes pasado?" },
  { n: 33, category: "cronologia", question: "¿Cuál fue la secuencia de hechos en marzo de 2025?" },
  { n: 34, category: "cronologia", question: "¿Qué eventos hubo en los últimos 3 meses?" },
  { n: 35, category: "cronologia", question: "¿Cómo se fueron dando los acuerdos este año?" },
  { n: 36, category: "cronologia", question: "¿Qué pasó desde que empezó el año?" },
  { n: 37, category: "cronologia", question: "¿Cuál fue el orden de los hechos en la última semana?" },
  { n: 38, category: "cronologia", question: "¿Qué eventos hubo entre abril y junio de 2025?" },

  // --- Sobre un Case ya formalizado (39-56) ---
  { n: 39, category: "case", question: "¿Cómo va el tema de los planes?" },
  { n: 40, category: "case", question: "¿Qué se ha acordado sobre los planes de fin de semana?" },
  { n: 41, category: "case", question: "¿Hay algún conflicto pendiente sobre los planes?" },
  { n: 42, category: "case", question: "¿Cómo va el tema del viaje?" },
  { n: 43, category: "case", question: "¿Qué se ha discutido sobre los viajes este año?" },
  { n: 44, category: "case", question: "¿Hay acuerdos pendientes sobre el viaje?" },
  { n: 45, category: "case", question: "¿Cómo va el tema de salud?" },
  { n: 46, category: "case", question: "¿Qué se ha hablado sobre citas médicas?" },
  { n: 47, category: "case", question: "¿Hay algo pendiente sobre salud?" },
  { n: 48, category: "case", question: "¿Cómo va el tema del trabajo?" },
  { n: 49, category: "case", question: "¿Qué se ha acordado sobre el trabajo este año?" },
  { n: 50, category: "case", question: "¿Hay algún desacuerdo sobre el trabajo?" },
  { n: 51, category: "case", question: "¿Cómo va el tema del presupuesto?" },
  { n: 52, category: "case", question: "¿Qué se ha hablado sobre los pagos?" },
  { n: 53, category: "case", question: "¿Hay algún atraso o pendiente en el presupuesto?" },
  { n: 54, category: "case", question: "¿Qué otros temas quedaron abiertos?" },
  { n: 55, category: "case", question: "¿Hay algún tema sin resolver fuera de las categorías habituales?" },
  { n: 56, category: "case", question: "¿Qué asuntos generales se trataron últimamente?" },

  // --- Búsqueda por significado / semántica (57-80) ---
  { n: 57, category: "semantica", question: "¿Hubo tensión por el tema de los viajes?" },
  { n: 58, category: "semantica", question: "¿En qué momentos hubo más conflicto?" },
  { n: 59, category: "semantica", question: "¿Cuándo se sintió más cooperación entre los participantes?" },
  { n: 60, category: "semantica", question: "¿Hubo algún malentendido sobre los horarios?" },
  { n: 61, category: "semantica", question: "¿De qué se habló relacionado con el bienestar de alguien?" },
  { n: 62, category: "semantica", question: "¿Hubo alguna vez que costó ponerse de acuerdo?" },
  { n: 63, category: "semantica", question: "¿Se habló de algo relacionado con dinero de forma indirecta?" },
  { n: 64, category: "semantica", question: "¿Hubo momentos de buena comunicación?" },
  { n: 65, category: "semantica", question: "¿Se habló alguna vez de cómo se sentía el equipo con el cambio?" },
  { n: 66, category: "semantica", question: "¿Hubo algo relacionado con desconfianza entre los participantes?" },
  { n: 67, category: "semantica", question: "¿Se mencionó alguna preocupación por un retraso?" },
  { n: 68, category: "semantica", question: "¿Hubo algún tema que generó una discusión fuerte?" },
  { n: 69, category: "semantica", question: "¿Se habló de planes a futuro para el proyecto?" },
  { n: 70, category: "semantica", question: "¿Hubo algo relacionado con adaptarse a un cambio?" },
  { n: 71, category: "semantica", question: "¿Se mencionó cansancio o estrés de algún participante?" },
  { n: 72, category: "semantica", question: "¿Hubo algo relacionado con la rutina diaria?" },
  { n: 73, category: "semantica", question: "¿Se habló de cómo repartir responsabilidades?" },
  { n: 74, category: "semantica", question: "¿Hubo algún reclamo indirecto entre los participantes?" },
  { n: 75, category: "semantica", question: "¿Se mencionó algo sobre cómo va todo en general?" },
  { n: 76, category: "semantica", question: "¿Hubo momentos donde se reconoció el esfuerzo del otro?" },
  { n: 77, category: "semantica", question: "¿Se habló de alguna preocupación por seguridad?" },
  { n: 78, category: "semantica", question: "¿Hubo algo relacionado con celebraciones?" },
  { n: 79, category: "semantica", question: "¿Se mencionó algo sobre amigos en común?" },
  { n: 80, category: "semantica", question: "¿Hubo algún tema de salud que no llegó a formalizarse?" },

  // --- Estadísticas (81-100) ---
  { n: 81, category: "estadisticas", question: "¿Cuántos mensajes hay en total?" },
  { n: 82, category: "estadisticas", question: "¿Quién escribió más mensajes?" },
  { n: 83, category: "estadisticas", question: "¿Cuántos temas están abiertos?" },
  { n: 84, category: "estadisticas", question: "¿Cuántos recordatorios pendientes hay?" },
  { n: 85, category: "estadisticas", question: "¿Cuántas propuestas se hicieron en total?" },
  { n: 86, category: "estadisticas", question: "¿Cuántas veces se rechazó algo?" },
  { n: 87, category: "estadisticas", question: "¿Cuántos acuerdos se cerraron?" },
  { n: 88, category: "estadisticas", question: "¿Cuántos cambios de horario hubo?" },
  { n: 89, category: "estadisticas", question: "¿Cuántas cancelaciones hubo?" },
  { n: 90, category: "estadisticas", question: "¿Cuál es el período que cubre la conversación?" },
  { n: 91, category: "estadisticas", question: "¿Cuántos mensajes hay sobre planes comparado con viajes?" },
  { n: 92, category: "estadisticas", question: "¿Cuántos temas hay por categoría?" },
  { n: 93, category: "estadisticas", question: "¿Cuántas discusiones se registraron?" },
  { n: 94, category: "estadisticas", question: "¿Cuál es la fecha del primer mensaje?" },
  { n: 95, category: "estadisticas", question: "¿Cuál es la fecha del último mensaje?" },
  { n: 96, category: "estadisticas", question: "¿Cuántos eventos hay en total?" },
  { n: 97, category: "estadisticas", question: "¿Cuántos mensajes envió cada participante?" },
  { n: 98, category: "estadisticas", question: "¿Cuántos temas de la categoría otro hay?" },
  { n: 99, category: "estadisticas", question: "¿Cuántos temas de viajes se registraron?" },
  { n: 100, category: "estadisticas", question: "¿Cuántas propuestas se aceptaron versus rechazaron?" },
];
