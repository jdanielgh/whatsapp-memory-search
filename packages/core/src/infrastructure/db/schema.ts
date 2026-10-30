// Esquema físico — traducción 1:1 de docs/DATA_MODEL.md a Drizzle ORM.
// No introducir tablas/columnas aquí sin reflejarlas primero en
// docs/DATA_MODEL.md (es la fuente de verdad del esquema, este archivo es su
// implementación).
//
// Cambios de esquema pasan por el subagente `rag-engineer`
// (rules/agents-and-context.md) cuando afectan el pipeline de embeddings;
// el resto es desarrollo normal pero SIEMPRE actualizando docs/DATA_MODEL.md
// en el mismo cambio.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------
// Evidencia (Aggregate: Conversation) — SI-002/003/043: inmutable, sin
// soft delete. Estas cuatro tablas nunca tienen updated_at/deleted_at.
// ---------------------------------------------------------------------

export const conversations = pgTable("conversations", {
  id: id(),
  title: text("title"),
  createdAt: createdAt(),
});

export const participants = pgTable("participants", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(), // etiqueta libre, ej. "organizador" | "miembro" | "sistema"
  createdAt: createdAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    // text | call | system — ver docs/DATA_MODEL.md "Clasificación de líneas"
    kind: text("kind").notNull().default("text"),
    // true si WhatsApp ya solo exportó el placeholder de borrado; NO es
    // soft delete del sistema (SI-043 intacto), registra un hecho previo
    // a la importación.
    deletedBySender: boolean("deleted_by_sender").notNull().default(false),
    rawSource: text("raw_source").notNull(),
    replyToMessageId: uuid("reply_to_message_id"),
    // NEW | IMPORTED | PERSISTED — se fija una sola vez al insertar y
    // nunca se actualiza después (SI-002: Message inmutable). El progreso
    // del Pipeline General (METADATA_READY, ENTITY_READY, ...) se
    // rastrea en `message_processing_state`, NO acá — ver esa tabla y
    // docs/DECISIONS.md, entrada "message_processing_state".
    status: text("status").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("messages_kind_check", sql`${table.kind} IN ('text','call','system')`),
  ]
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    // imagen | audio | video | documento | sticker
    type: text("type").notNull(),
    // available | unavailable — un export de solo texto referencia
    // adjuntos sin que exista el archivo real (ver docs/DATA_MODEL.md).
    status: text("status").notNull().default("unavailable"),
    storagePath: text("storage_path"),
    fileHash: text("file_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "attachments_type_check",
      sql`${table.type} IN ('imagen','audio','video','documento','sticker')`
    ),
    check(
      "attachments_status_check",
      sql`${table.status} IN ('available','unavailable')`
    ),
  ]
);

export const sources = pgTable("sources", {
  id: id(),
  // whatsapp_export | whatsapp_live (futuro)
  type: text("type").notNull(),
  createdAt: createdAt(),
});

export const importJobs = pgTable("import_jobs", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id),
  // PENDING | RUNNING | SUCCESS | FAILED | RETRYING | MANUAL_REVIEW
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  messagesImported: integer("messages_imported").notNull().default(0),
  errorSummary: text("error_summary"),
});

// Tracking del progreso del Pipeline General (docs/PIPELINES.md, "Estados
// del procesamiento") por Message. NO es evidencia (no está en la lista
// de conversations/participants/messages/attachments de SI-002/003/043):
// es una tabla de conocimiento derivada, se actualiza in place por
// diseño. Existe porque derivar el estado de "¿existe fila en la tabla
// de la etapa X?" no funciona para etapas de salida 0:N (Entity/Event
// Detection: un mensaje sin entidades/eventos detectados es un resultado
// válido, indistinguible de "todavía no procesado" si solo se mira
// presencia de filas en message_entities/events). Con esta tabla, cada
// etapa marca explícitamente que corrió, haya encontrado algo o no.
// Sin fila = 'PERSISTED' implícito (no hace falta que archive/ cree la
// fila al insertar el Message — eso acoplaría archive con processing).
// La crea/actualiza (upsert) la primera etapa del Pipeline General que
// procesa ese mensaje. Ver docs/DECISIONS.md, entrada
// "message_processing_state".
export const messageProcessingState = pgTable("message_processing_state", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id),
  // PERSISTED | METADATA_READY | ENTITY_READY | EVENT_READY |
  // CASE_READY | INSIGHT_READY | SUMMARY_READY | EMBEDDED | INDEXED |
  // READY (ver docs/PIPELINES.md). Progresión estrictamente creciente
  // aplicada por el código de cada pipeline, no por constraint SQL.
  status: text("status").notNull().default("PERSISTED"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------
// Conocimiento (Aggregate: Case)
// ---------------------------------------------------------------------

export const cases = pgTable("cases", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  title: text("title").notNull(),
  // valores del perfil de dominio activo (shared/domain-profile.ts)
  category: text("category").notNull(),
  status: text("status").notNull().default("open"), // open | closed
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable("events", {
  id: id(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => cases.id),
  // propuesta | aceptación | rechazo | cambio_horario | discusión |
  // acuerdo | cancelación | actividad
  type: text("type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// Tabla puente: un Event puede respaldarse en varios Message (SI-014).
export const eventMessages = pgTable(
  "event_messages",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.messageId] })]
);

export const insights = pgTable("insights", {
  id: id(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => cases.id),
  statement: text("statement").notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  derivedFromEventIds: uuid("derived_from_event_ids").array().notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const relationships = pgTable("relationships", {
  id: id(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => cases.id),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  predicate: text("predicate").notNull(),
  objectType: text("object_type").notNull(),
  objectId: uuid("object_id").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------
// Entidades extraídas — parte del Aggregate Conversation vía Message,
// sin repositorio propio (AG-002).
// ---------------------------------------------------------------------

export const messageEntities = pgTable("message_entities", {
  id: id(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id),
  // persona | lugar | fecha | hora | institución | actividad | dinero
  entityType: text("entity_type").notNull(),
  value: text("value").notNull(),
  normalizedValue: text("normalized_value"),
  createdAt: createdAt(),
});

// Metadata Extraction (Pipeline 3, docs/PIPELINES.md) — determinista, sin
// IA. 1:1 con Message (a diferencia de message_entities, que es 0:N),
// parte del Aggregate Conversation vía Message, sin repositorio propio
// (AG-002). Regenerable in place (updated_at): al ser 1:1 un UPDATE no
// genera ambigüedad de "qué versión es la vigente" como sí ocurre en
// `analyses` (que por eso necesita `superseded_by`), así que no lleva
// `model`/`prompt_version` (SI-019/020 son para Analysis con IA
// involucrada). Ver docs/DATA_MODEL.md, sección "Metadata extraída".
export const messageMetadata = pgTable("message_metadata", {
  id: id(),
  messageId: uuid("message_id")
    .notNull()
    .unique()
    .references(() => messages.id),
  // ISO 639-1 (ej. "es", "fr"); NULL si no se pudo determinar (mensaje
  // muy corto, solo emoji, o kind != 'text').
  language: text("language"),
  emojiCount: integer("emoji_count").notNull().default(0),
  // Emojis encontrados, en orden de aparición (con repetición).
  emojis: text("emojis").array().notNull().default(sql`'{}'::text[]`),
  // Participant.id detectados por mención en el texto — FK lógica, no
  // hay constraint de FK sobre columnas array en Postgres.
  mentionedParticipantIds: uuid("mentioned_participant_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  // Nombres detectados en el texto que no matchean ningún Participant
  // registrado (ej. terceros mencionados
  // por nombre). Mismo nivel de sensibilidad que messages.content — ver
  // rules/security-privacy.md regla 2.
  mentionedRawNames: text("mentioned_raw_names")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------
// Artefactos derivados — SIN Aggregate Root, sin repositorio propio
// (docs/AGGREGATES.md). Referencia polimórfica subject_type/subject_id.
// ---------------------------------------------------------------------

export const analyses = pgTable("analyses", {
  id: id(),
  subjectType: text("subject_type").notNull(), // Conversation | Message | Case | Event
  subjectId: uuid("subject_id").notNull(),
  // Una de profile.analysisDimensions (perfil de dominio activo); el perfil
  // genérico usa formalidad | cordialidad | tensión | cooperación
  dimension: text("dimension").notNull(),
  score: numeric("score", { precision: 3, scale: 2 }).notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  model: text("model").notNull(), // SI-019
  promptVersion: text("prompt_version").notNull(), // SI-020
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(), // SI-021
  // Versionado: nunca se sobrescribe, se enlaza a la fila que la reemplaza.
  supersededBy: uuid("superseded_by"),
});

export const observations = pgTable("observations", {
  id: id(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  statement: text("statement").notNull(),
  promotedToInsightId: uuid("promoted_to_insight_id").references(
    () => insights.id
  ),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
});

export const summaries = pgTable("summaries", {
  id: id(),
  scope: text("scope").notNull(), // day | week | month | case | conversation
  subjectType: text("subject_type").notNull(), // Case | Conversation
  subjectId: uuid("subject_id").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  content: text("content").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
});

// Dimensión del vector: voyage-3-large a 1024 dimensiones (Matryoshka),
// fijado por rag-engineer — ver docs/DECISIONS.md, "Embeddings:
// proveedor, modelo, chunking, top-k y regeneración". Cambiar aquí y en
// docs/DATA_MODEL.md a la vez si el modelo elegido cambia de dimensión —
// eso es una migración destructiva de esta columna (trunca `embeddings`,
// que es regenerable por definición, SI-028/SI-029; nunca toca `messages`).
const EMBEDDING_DIMENSIONS = 1024;

export const embeddings = pgTable("embeddings", {
  id: id(),
  subjectType: text("subject_type").notNull(), // Message | Event | Case | Insight | Summary
  subjectId: uuid("subject_id").notNull(),
  model: text("model").notNull(),
  dims: integer("dims").notNull(),
  vector: vector("vector", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------
// Asistente — Reminder es Aggregate Root. Draft/Suggestion aún sin
// Aggregate Root formal (ver nota abierta en docs/DATA_MODEL.md).
// ---------------------------------------------------------------------

export const reminders = pgTable("reminders", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  caseId: uuid("case_id").references(() => cases.id),
  eventId: uuid("event_id").references(() => events.id),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"), // pending | completed | postponed | cancelled
  requiresApproval: boolean("requires_approval").notNull().default(true), // SI-040
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const drafts = pgTable("drafts", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  caseId: uuid("case_id").references(() => cases.id),
  content: text("content").notNull(),
  status: text("status").notNull().default("proposed"), // proposed | approved | discarded
  model: text("model").notNull(),
  createdAt: createdAt(),
});

export const suggestions = pgTable("suggestions", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  draftId: uuid("draft_id").references(() => drafts.id),
  content: text("content").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------
// Auditoría (Governance Layer) — nunca se borra.
// ---------------------------------------------------------------------

export const systemAuditLog = pgTable("system_audit_log", {
  id: id(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  actor: text("actor").notNull(), // "user" | nombre de pipeline/proceso
  operation: text("operation").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id"),
  result: text("result").notNull(), // success | failure
  details: jsonb("details"),
});
