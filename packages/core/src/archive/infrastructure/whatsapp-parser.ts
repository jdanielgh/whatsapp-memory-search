// Parser de export de WhatsApp (.txt), formato iOS confirmado sobre una
// muestra real (ver docs/DECISIONS.md, entrada "Validación del formato
// real de export"). Puro: no toca la base de datos ni dispara IA
// (docs/ARCHITECTURE.md, "Archive Layer" — "Nunca ejecuta IA. Nunca
// interpreta información"). El caso de uso ImportConversation
// (plans/) consume su salida para persistir.
//
// Formato de línea de encabezado confirmado:
//   [dd/mm/yy, h:mm:ss a.m./p.m.] Nombre: contenido
// con espacio angosto de no separación (U+202F, no un espacio normal)
// antes de "a.m./p.m." y marca LRM (U+200E) antes de encabezados de
// sistema/multimedia. No asumir un único patrón de espaciado o
// mayúsculas — varía dentro del mismo archivo. El a.m./p.m. es opcional
// en el regex para admitir exports en formato 24h (plans/
// exige no asumir un único formato de hora/fecha).
//
// `messages.kind` (text/call/system) se resuelve acá, durante el parseo
// (Pipeline 1 / Persist Evidence), no en Metadata Extraction (Pipeline 3)
// como sugiere una lectura literal de docs/DATA_MODEL.md — tiene que ser
// así porque `messages.kind` es NOT NULL desde el insert y `messages` es
// inmutable (SI-002, sin UPDATE jamás): para cuando Pipeline 3 corriera,
// ya sería tarde para fijar `kind` sin violar esa invariante. Ver
// corrección en docs/DATA_MODEL.md.

const LRM = "‎";

// El nombre del remitente nunca contiene ":" — por eso alcanza con
// buscar el primer ":" tras el encabezado para separarlo del contenido.
// Asume conversación 1:1 (confirmado sobre la muestra real: 2
// remitentes) — un mensaje de sistema cuyo texto contenga ":" (aviso de
// encuesta, cambio de grupo, mensaje de cuenta de negocio) puede
// matchear este heurístico como si fuera un remitente real. Mitigado en
// tiempo de parseo llevando el conjunto de remitentes ya vistos: como la
// conversación es 1:1, un tercer "remitente" nunca visto genera un
// warning para revisión manual en vez de fallar en silencio (no se
// descarta el mensaje — evitar la pérdida de evidencia, EH-001).
const HEADER_WITH_SENDER_RE =
  /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2}),\s(\d{1,2}):(\d{2}):(\d{2})[  ]?(a\.?\s?m\.?|p\.?\s?m\.?)?\]\s(‎?[^:]+):\s([\s\S]*)$/i;

// Encabezados de sistema (aviso de cifrado, cambios de grupo): mismo
// prefijo `[fecha, hora]`, pero sin "Nombre:" — se prueba solo cuando
// HEADER_WITH_SENDER_RE ya falló (es decir, el resto de la línea no
// contiene ningún ":").
const SYSTEM_HEADER_RE =
  /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2}),\s(\d{1,2}):(\d{2}):(\d{2})[  ]?(a\.?\s?m\.?|p\.?\s?m\.?)?\]\s([\s\S]*)$/i;

// Línea que "parece" un encabezado (empieza con el prefijo de fecha
// `[dd/mm/yy,`) pero no matcheó ninguno de los dos regex de arriba —
// variante de formato no soportada. Sirve para avisar en vez de fusionar
// la línea en silencio dentro del mensaje abierto (docs/ERROR_HANDLING.md,
// EH-002: "todo error debe registrarse").
const LOOKS_LIKE_HEADER_RE = /^‎?\[\d{1,2}\/\d{1,2}\/\d{2},/;

// Anclados de punta a punta (con posible espacio final): el placeholder
// completo es el mensaje, no una palabra suelta dentro de una oración
// real (una conversación real puede mencionar "se eliminó este mensaje"
// o "imagen omitida" al hablar de otra cosa).
const DELETED_RE = /^(se elimin[oó] este mensaje|eliminaste este mensaje)\.?$/i;
const CALL_RE = /^‎?(llamada perdida|videollamada)\s*$/i;

const ATTACHMENT_PATTERNS: Array<{
  type: "imagen" | "audio" | "video" | "documento" | "sticker";
  re: RegExp;
}> = [
  { type: "imagen", re: /^imagen omitida$/i },
  { type: "audio", re: /^audio omitido$/i },
  { type: "video", re: /^video omitido$/i },
  { type: "documento", re: /^documento omitido$/i },
  { type: "sticker", re: /^sticker omitido$/i },
];

// Mismos valores que las constraints `messages_kind_check` /
// `attachments_type_check` / `attachments_status_check` en
// src/infrastructure/db/schema.ts (docs/DATA_MODEL.md es la fuente de
// verdad del esquema). No hay un tipo compartido entre ambos archivos:
// un `text()` con CHECK en Drizzle no expone sus valores permitidos a
// nivel de tipo (a diferencia de `pgEnum`), y convertir esas columnas a
// `pgEnum` es un cambio de esquema que pasa por `rag-engineer`
// (rules/agents-and-context.md), no por este archivo. Si se agrega un
// valor acá, agregarlo también en schema.ts, y viceversa.
export type ParsedMessageKind = "text" | "call" | "system";

export interface ParsedAttachment {
  type: "imagen" | "audio" | "video" | "documento" | "sticker";
  // v1 solo procesa exports de solo texto (sin carpeta de medios) —
  // ver docs/DATA_MODEL.md, tabla attachments.
  status: "unavailable";
}

export interface ParsedMessage {
  /** null cuando la línea no trae remitente identificable (mensajes de sistema). */
  displayName: string | null;
  sentAt: Date;
  content: string;
  kind: ParsedMessageKind;
  deletedBySender: boolean;
  attachment: ParsedAttachment | null;
  /** Línea(s) original(es) del export, para auditoría de parseo (docs/DATA_MODEL.md). */
  rawSource: string;
  /** Número de línea (1-indexado) donde empieza el mensaje en el export original. */
  sourceLineNumber: number;
}

export interface ParseWarning {
  lineNumber: number;
  rawLine: string;
  reason: string;
}

export interface ParseResult {
  messages: ParsedMessage[];
  warnings: ParseWarning[];
}

/**
 * Estrategia de huso horario para resolver `sent_at`. 'fixed' usa el
 * mismo offset para todo el archivo (correcto solo si el huso de origen
 * no observa horario de verano, o si el export no cruza ningún cambio).
 * 'eu-cet-cest' calcula el offset real por mensaje según el calendario
 * de cambio de horario de la Unión Europea (los países
 * miembros comparten el mismo calendario desde 1996) — necesario porque un offset único
 * corrompe en ~1h los mensajes del lado equivocado de cada transición
 * marzo/octubre en un export que abarca varias estaciones/años.
 */
export type TimeZoneStrategy =
  | { kind: "fixed"; utcOffsetMinutes: number }
  | { kind: "eu-cet-cest" };

export interface ParseOptions {
  /**
   * Sin default silencioso a propósito (mismo criterio que
   * src/shared/config.ts con EMBEDDING_MODEL): asumir un huso incorrecto
   * corrompe `sent_at` de forma silenciosa.
   */
  timeZone: TimeZoneStrategy;
  /**
   * Orden de los dos primeros números de fecha del export: 'dmy'
   * (día/mes/año, confirmado sobre la muestra real) o 'mdy' (mes/día/año,
   * exports de teléfonos en inglés). Sin default silencioso a propósito
   * (plans/: "nunca asumir un formato fijo").
   */
  dateFormat: "dmy" | "mdy";
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/** Día del mes (1-31) del último domingo de `monthIndex0` (0=enero). */
function lastSundayOfMonth(year: number, monthIndex0: number): number {
  const total = daysInMonth(year, monthIndex0);
  const lastDayWeekday = new Date(Date.UTC(year, monthIndex0, total)).getUTCDay();
  return total - lastDayWeekday;
}

/**
 * Offset UTC (minutos) para una fecha civil en Europa central (CET/CEST).
 * El cambio real ocurre a una hora UTC exacta (01:00 UTC el último
 * domingo de marzo y de octubre), no a medianoche — esta función
 * aproxima a nivel de día completo (el día de la transición se clasifica
 * ya con el huso "de destino", que es correcto para casi todas las horas
 * de ese día salvo la ventana de 1-2h alrededor del cambio mismo). Para
 * mensajes de chat esa imprecisión puntual es aceptable frente a la
 * alternativa de una librería de zonas horarias completa.
 */
function resolveEuCetCestOffsetMinutes(
  year: number,
  monthIndex0: number,
  day: number
): number {
  const CET_MINUTES = 60;
  const CEST_MINUTES = 120;
  const dstStartDay = lastSundayOfMonth(year, 2); // marzo
  const dstEndDay = lastSundayOfMonth(year, 9); // octubre

  if (monthIndex0 < 2 || monthIndex0 > 9) return CET_MINUTES;
  if (monthIndex0 > 2 && monthIndex0 < 9) return CEST_MINUTES;
  if (monthIndex0 === 2) return day >= dstStartDay ? CEST_MINUTES : CET_MINUTES;
  return day < dstEndDay ? CEST_MINUTES : CET_MINUTES; // monthIndex0 === 9
}

function resolveUtcOffsetMinutes(
  timeZone: TimeZoneStrategy,
  year: number,
  monthIndex0: number,
  day: number
): number {
  return timeZone.kind === "fixed"
    ? timeZone.utcOffsetMinutes
    : resolveEuCetCestOffsetMinutes(year, monthIndex0, day);
}

function normalizeLineEndings(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/);
}

function to24Hour(hour: string, meridiem: string | undefined): number {
  if (!meridiem) {
    // Sin a.m./p.m.: export en formato 24h, la hora ya viene en ese rango.
    return Number(hour) % 24;
  }
  const h = Number(hour) % 12;
  const isPm = /^p/i.test(meridiem);
  return isPm ? h + 12 : h;
}

function buildDate(
  first: string,
  second: string,
  year2: string,
  hour: string,
  minute: string,
  second_: string,
  meridiem: string | undefined,
  timeZone: TimeZoneStrategy,
  dateFormat: "dmy" | "mdy"
): Date {
  // Año de 2 dígitos: el export no distingue siglo. Se asume 20xx —
  // documentar si algún día aparece una muestra real de otro siglo.
  const year = 2000 + Number(year2);
  const day = Number(dateFormat === "dmy" ? first : second);
  const month = Number(dateFormat === "dmy" ? second : first);
  const hour24 = to24Hour(hour, meridiem);
  const utcOffsetMinutes = resolveUtcOffsetMinutes(timeZone, year, month - 1, day);
  const utcMs =
    Date.UTC(year, month - 1, day, hour24, Number(minute), Number(second_)) -
    utcOffsetMinutes * 60_000;
  return new Date(utcMs);
}

function stripLeadingLrm(text: string): string {
  return text.startsWith(LRM) ? text.slice(LRM.length) : text;
}

function classifyContent(
  content: string
): Pick<ParsedMessage, "kind" | "deletedBySender" | "attachment"> {
  const trimmed = stripLeadingLrm(content).trim();

  if (DELETED_RE.test(trimmed)) {
    return { kind: "text", deletedBySender: true, attachment: null };
  }

  if (CALL_RE.test(trimmed)) {
    return { kind: "call", deletedBySender: false, attachment: null };
  }

  const attachmentMatch = ATTACHMENT_PATTERNS.find((p) => p.re.test(trimmed));
  if (attachmentMatch) {
    return {
      kind: "text",
      deletedBySender: false,
      attachment: { type: attachmentMatch.type, status: "unavailable" },
    };
  }

  return { kind: "text", deletedBySender: false, attachment: null };
}

interface OpenMessage {
  displayName: string | null;
  sentAt: Date;
  forcedKind: ParsedMessageKind | null;
  contentLines: string[];
  rawLines: string[];
  startLineNumber: number;
}

type HeaderMatch =
  | {
      kind: "sender";
      first: string;
      second: string;
      year2: string;
      hour: string;
      minute: string;
      second_: string;
      meridiem: string | undefined;
      sender: string;
      content: string;
    }
  | {
      kind: "system";
      first: string;
      second: string;
      year2: string;
      hour: string;
      minute: string;
      second_: string;
      meridiem: string | undefined;
      content: string;
    };

function matchHeader(line: string): HeaderMatch | null {
  const withSender = HEADER_WITH_SENDER_RE.exec(line);
  if (withSender) {
    const [, first, second, year2, hour, minute, second_, meridiem, sender, content] =
      withSender as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | undefined,
        string,
        string
      ];
    return {
      kind: "sender",
      first,
      second,
      year2,
      hour,
      minute,
      second_,
      meridiem,
      sender: stripLeadingLrm(sender).trim(),
      content,
    };
  }

  const system = SYSTEM_HEADER_RE.exec(line);
  if (system) {
    const [, first, second, year2, hour, minute, second_, meridiem, content] =
      system as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | undefined,
        string
      ];
    return {
      kind: "system",
      first,
      second,
      year2,
      hour,
      minute,
      second_,
      meridiem,
      content,
    };
  }

  return null;
}

export function parseWhatsAppExport(
  raw: string,
  opts: ParseOptions
): ParseResult {
  const lines = normalizeLineEndings(raw);
  const messages: ParsedMessage[] = [];
  const warnings: ParseWarning[] = [];
  let open: OpenMessage | null = null;
  // Conversación asumida 1:1 (ver comentario junto a HEADER_WITH_SENDER_RE):
  // se registra qué remitentes ya se vieron para poder advertir si aparece
  // un tercero (probable falso positivo del heurístico remitente/sistema).
  const knownSenders = new Set<string>();

  const closeOpen = () => {
    if (!open) return;
    const content = stripLeadingLrm(open.contentLines.join("\n"));
    const classified = open.forcedKind
      ? { kind: open.forcedKind, deletedBySender: false, attachment: null }
      : classifyContent(content);
    messages.push({
      displayName: open.displayName,
      sentAt: open.sentAt,
      content,
      ...classified,
      rawSource: open.rawLines.join("\n"),
      sourceLineNumber: open.startLineNumber,
    });
    open = null;
  };

  lines.forEach((line, index) => {
    const header = matchHeader(line);

    if (!header) {
      if (line.trim() === "" && index === lines.length - 1) {
        // Última línea vacía por el split (archivo termina en salto de línea).
        return;
      }
      if (open) {
        if (LOOKS_LIKE_HEADER_RE.test(line)) {
          warnings.push({
            lineNumber: index + 1,
            rawLine: line,
            reason:
              "Línea con prefijo de fecha reconocible pero encabezado no soportado (variante de formato no cubierta) — se adjuntó como continuación del mensaje anterior; revisar manualmente que no sea un mensaje propio perdido.",
          });
        }
        open.contentLines.push(line);
        open.rawLines.push(line);
        return;
      }
      warnings.push({
        lineNumber: index + 1,
        rawLine: line,
        reason:
          "Línea sin encabezado de mensaje y sin mensaje abierto al que adjuntarla (¿primera línea con formato inesperado?).",
      });
      return;
    }

    closeOpen();

    const sentAt = buildDate(
      header.first,
      header.second,
      header.year2,
      header.hour,
      header.minute,
      header.second_,
      header.meridiem,
      opts.timeZone,
      opts.dateFormat
    );

    if (header.kind === "sender") {
      if (knownSenders.size >= 2 && !knownSenders.has(header.sender)) {
        warnings.push({
          lineNumber: index + 1,
          rawLine: line,
          reason: `Remitente "${header.sender}" no visto antes y ya había 2 remitentes conocidos (la conversación se asume 1:1) — revisar si es un falso positivo del heurístico remitente/sistema (p. ej. un aviso de sistema con ":").`,
        });
      }
      knownSenders.add(header.sender);
    }

    open =
      header.kind === "sender"
        ? {
            displayName: header.sender,
            sentAt,
            forcedKind: null,
            contentLines: [header.content],
            rawLines: [line],
            startLineNumber: index + 1,
          }
        : {
            displayName: null,
            sentAt,
            forcedKind: "system",
            contentLines: [header.content],
            rawLines: [line],
            startLineNumber: index + 1,
          };
  });

  closeOpen();

  return { messages, warnings };
}
