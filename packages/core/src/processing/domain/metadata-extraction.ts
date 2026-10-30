// Pipeline 3 - Metadata Extraction (docs/PIPELINES.md). Determinista, sin
// IA: idioma, emojis y menciones a partir del `content` de un Message ya
// persistido. Longitud/tipo/reply/adjuntos NO se recalculan acá — ya
// están cubiertos por columnas/tablas existentes (docs/DATA_MODEL.md,
// sección "Metadata extraída").

export interface ParticipantRef {
  id: string;
  displayName: string;
}

export interface ExtractedMetadata {
  language: string | null;
  emojis: string[];
  emojiCount: number;
  mentionedParticipantIds: string[];
  mentionedRawNames: string[];
}

// Palabras funcionales de alta frecuencia por idioma — heurística simple
// y determinista (sin IA, sin dependencia externa). Cubre los dos
// idiomas reales de la conversación (es/fr, ver docs/DECISIONS.md,
// "Detección automática de horario de verano europeo") más inglés como
// tercer candidato razonable. No pretende ser un detector de idioma
// general: si el resultado es ambiguo (empate, o ninguna palabra
// reconocida), devuelve null en vez de adivinar.
const STOPWORDS: Record<string, Set<string>> = {
  es: new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del",
    "que", "y", "en", "a", "por", "para", "con", "no", "es", "se", "lo",
    "le", "su", "sus", "yo", "tu", "vos", "nosotros", "ellos", "ella",
    "pero", "como", "más", "si", "ya", "muy", "esta", "este", "eso",
    "vale", "gracias", "hola", "porque", "cuando", "también", "hoy",
  ]),
  fr: new Set([
    "le", "la", "les", "un", "une", "des", "de", "du", "que", "et", "en",
    "à", "pour", "avec", "ne", "pas", "est", "se", "ce", "je", "tu", "il",
    "elle", "nous", "vous", "ils", "mais", "comme", "plus", "si", "déjà",
    "très", "cette", "cet", "merci", "bonjour", "parce", "quand", "aussi",
    "aujourd'hui", "oui", "non",
  ]),
  en: new Set([
    "the", "a", "an", "of", "that", "and", "in", "to", "for", "with",
    "not", "is", "it", "he", "she", "we", "they", "but", "as", "more",
    "if", "already", "very", "this", "thanks", "hello", "because",
    "when", "also", "today", "yes", "no",
  ]),
};

const WORD_PATTERN = /\p{L}+(?:'\p{L}+)?/gu;

/**
 * Heurística por conteo de palabras funcionales. Devuelve null si el
 * texto es demasiado corto para ser confiable, o si no hay un idioma
 * claramente dominante (cero coincidencias, o empate entre el primero y
 * el segundo).
 */
export function detectLanguage(content: string): string | null {
  const words = (content.toLowerCase().match(WORD_PATTERN) ?? []);
  if (words.length < 2) return null;

  const scores = Object.entries(STOPWORDS).map(([lang, set]) => {
    const score = words.reduce((acc, w) => acc + (set.has(w) ? 1 : 0), 0);
    return { lang, score };
  });
  scores.sort((a, b) => b.score - a.score);

  const [best, second] = scores;
  if (!best || best.score === 0) return null;
  if (second && second.score === best.score) return null;
  return best.lang;
}

const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;

/** Emojis en orden de aparición, con repetición. */
export function extractEmojis(content: string): string[] {
  return content.match(EMOJI_PATTERN) ?? [];
}

const MENTION_MARKER_PATTERN = /@([\p{L}\p{N}_]+)/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Menciones deterministas: (a) nombre de un Participant existente
 * mencionado como palabra dentro del texto (case-insensitive), y (b)
 * marcadores explícitos "@algo" (como los exporta WhatsApp para
 * @menciones) que no matchean ningún Participant conocido — ver
 * docs/DATA_MODEL.md, sección "Metadata extraída", sobre
 * mentioned_raw_names. No es NER: no intenta reconocer nombres de
 * terceros que no estén ya registrados como Participant ni marcados con
 * "@" — eso es Entity Detection (Pipeline 4, con IA).
 */
export function extractMentions(
  content: string,
  participants: ParticipantRef[]
): Pick<ExtractedMetadata, "mentionedParticipantIds" | "mentionedRawNames"> {
  const mentionedParticipantIds: string[] = [];
  for (const p of participants) {
    if (!p.displayName.trim()) continue;
    // \b es ASCII-only en JS (se basa en \w = [A-Za-z0-9_]) incluso con el
    // flag "u" — con nombres que empiezan/terminan en letra acentuada
    // ("Ángela", "Óscar", "Émile", comunes en español y francés) \b nunca
    // matchea el límite y la mención se pierde en silencio. Lookaround
    // con \p{L}/\p{N} es Unicode-consciente de verdad.
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(p.displayName)}(?![\\p{L}\\p{N}_])`,
      "iu"
    );
    if (pattern.test(content)) {
      mentionedParticipantIds.push(p.id);
    }
  }

  const knownNamesLower = new Set(
    participants.map((p) => p.displayName.trim().toLowerCase())
  );
  const rawMentions = content.matchAll(MENTION_MARKER_PATTERN);
  const mentionedRawNames = [
    ...new Set(
      [...rawMentions]
        .map((m) => m[1]!)
        .filter((name) => !knownNamesLower.has(name.toLowerCase()))
    ),
  ];

  return { mentionedParticipantIds, mentionedRawNames };
}

/**
 * kind != 'text' (call/system, docs/DATA_MODEL.md "Clasificación de
 * líneas") no tiene contenido de un participante real que analizar:
 * idioma/emojis/menciones quedan vacíos, pero la fila se crea igual
 * (ver message-processing-state) para no reprocesar indefinidamente.
 */
export function extractMetadata(
  message: { content: string; kind: string },
  participants: ParticipantRef[]
): ExtractedMetadata {
  if (message.kind !== "text") {
    return {
      language: null,
      emojis: [],
      emojiCount: 0,
      mentionedParticipantIds: [],
      mentionedRawNames: [],
    };
  }

  const emojis = extractEmojis(message.content);
  const { mentionedParticipantIds, mentionedRawNames } = extractMentions(
    message.content,
    participants
  );

  return {
    language: detectLanguage(message.content),
    emojis,
    emojiCount: emojis.length,
    mentionedParticipantIds,
    mentionedRawNames,
  };
}
