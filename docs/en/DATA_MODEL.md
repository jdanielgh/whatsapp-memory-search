# DATA_MODEL.md

[Español](../DATA_MODEL.md) · **English**

# Conversation Memory Assistant

## Purpose

This document translates [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) and
[`AGGREGATES.md`](AGGREGATES.md) into a concrete physical schema on
**PostgreSQL + pgvector** (a decision already fixed in
[`ARCHITECTURE.md`](ARCHITECTURE.md)).

It is the schema-level data model (tables, columns, types, indexes), not a
redefinition of the Aggregates. For consistency boundaries and Aggregate
Roots, the reference remains [`AGGREGATES.md`](AGGREGATES.md): `Analysis`,
`Observation`, `Summary` and `Embedding` are **derived artifacts with no
repository of their own**.

It introduces no new business concepts. Every table corresponds to an entity
already defined in [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md).

> **A note on language.** Table and column names are in English. Some stored
> *values* (event types, entity types, analysis dimensions, attachment types)
> are kept in Spanish because that is what the code and the database store;
> they are glossed in the comments below.

---

## Conventions

* Domain entity names: singular (`Message`). Table names: plural in
  `snake_case` (`messages`). This is the only translation allowed between the
  ubiquitous language and the physical schema.
* Every table has `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — a unique,
  immutable identifier (SI-042).
* Every table records `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
* No evidence table (`conversations`, `participants`, `messages`,
  `attachments`) has an `updated_at` or `deleted_at` column: evidence is not
  updated and does not use soft delete (SI-002, SI-003, SI-043).
* Knowledge tables and derived-artifact tables may have `updated_at` because
  they are regenerable.
* Foreign keys between different Aggregates are stored as a plain UUID, never
  as an object reference (AG-003).

---

## Evidence (Aggregate: Conversation)

```sql
conversations
  id UUID PK
  title TEXT NULL
  created_at TIMESTAMPTZ

participants
  id UUID PK
  conversation_id UUID FK -> conversations.id
  display_name TEXT NOT NULL
  role TEXT NOT NULL            -- free label, e.g. "organizador" (organizer) | "miembro" (member) | "sistema" (system)
  created_at TIMESTAMPTZ

messages
  id UUID PK
  conversation_id UUID FK -> conversations.id
  participant_id UUID FK -> participants.id
  sent_at TIMESTAMPTZ NOT NULL
  content TEXT NOT NULL
  kind TEXT NOT NULL DEFAULT 'text'  -- text | call | system (see "Line classification" below)
  deleted_by_sender BOOLEAN NOT NULL DEFAULT false  -- true if WhatsApp only exported the deletion placeholder
  raw_source TEXT NOT NULL      -- original line of the export, to audit parsing
  reply_to_message_id UUID NULL FK -> messages.id
  status TEXT NOT NULL          -- NEW | IMPORTED | PERSISTED (set once at insert time, never updated — see "General Pipeline state" below)
  content_hash TEXT NOT NULL    -- integrity hash (see SECURITY.md "Integrity")
  created_at TIMESTAMPTZ
  -- no updated_at / no deleted_at: immutable, no soft delete.
  -- `deleted_by_sender` is NOT a system soft delete (SI-043 intact):
  -- it records a fact that happened in WhatsApp before the import. In that
  -- case `content` is the placeholder text WhatsApp exported ("This message
  -- was deleted"), never invented or recovered content.

attachments
  id UUID PK
  message_id UUID FK -> messages.id
  type TEXT NOT NULL            -- imagen (image) | audio | video | documento (document) | sticker
  status TEXT NOT NULL DEFAULT 'unavailable'  -- available | unavailable
  storage_path TEXT NULL        -- NULL if status = unavailable
  file_hash TEXT NULL           -- NULL if status = unavailable
  created_at TIMESTAMPTZ
  -- A text-only export (a chat .txt without a media folder) references
  -- attachments ("image omitted", etc.) without the real file existing.
  -- That row is created anyway (so as not to lose the fact that there was an
  -- attachment), with status='unavailable' and no path/hash. If the same
  -- period is later imported from an export that includes media, that row can
  -- be completed (status='available' + path + hash) without duplicating the
  -- Message it belongs to.

sources
  id UUID PK
  type TEXT NOT NULL            -- whatsapp_export | whatsapp_live (future)
  created_at TIMESTAMPTZ

import_jobs
  id UUID PK
  conversation_id UUID FK -> conversations.id
  source_id UUID FK -> sources.id
  status TEXT NOT NULL          -- PENDING | RUNNING | SUCCESS | FAILED | RETRYING | MANUAL_REVIEW
  started_at TIMESTAMPTZ
  finished_at TIMESTAMPTZ NULL
  messages_imported INT NOT NULL DEFAULT 0
  error_summary TEXT NULL
```

Indexes: `messages(conversation_id, sent_at)`, `messages(participant_id)`, and
a `GIN` index over `to_tsvector('spanish', content)` for Exact Search by text.
(The text-search configuration is a parameter of the index; it is `spanish`
today because that is the language of the conversations the project was built
around.)

### Line classification (`messages.kind`)

A real WhatsApp export mixes, with the same line format
`[date, time] Name: ...`, three different things. They are told apart while
parsing the export (Pipeline 1 / Persist Evidence, `whatsapp-parser.ts`), not
in Metadata Extraction (Pipeline 3): `messages.kind` is `NOT NULL` from the
insert and `messages` is immutable (SI-002, never an `UPDATE`), so it has to
be resolved before the row is persisted, not afterwards asynchronously. They
are persisted in `messages.kind`:

* `text` — message written by a participant. The default case.
* `call` — line generated by WhatsApp for a voice/video call ("Missed call",
  "Video call"). This is not Event Detection (Pipeline 5) yet — it is only a
  structural classification; if it is later decided to model calls as
  `Event`, it starts from here.
* `system` — notices generated by WhatsApp, not by a participant (the
  encryption notice at the start of the export, group changes if any). The
  associated `Participant` may not represent a real person — see the
  `whatsapp-ingest` skill, note on the "System" Participant.

`deleted_by_sender = true` is orthogonal to `kind` (today it is only observed
with `kind = 'text'`): `content` is the placeholder WhatsApp exported, not the
original message — WhatsApp no longer keeps it at export time, so the system
cannot reconstruct it either.

---

## Knowledge (Aggregate: Case)

```sql
cases
  id UUID PK
  conversation_id UUID FK -> conversations.id
  title TEXT NOT NULL
  category TEXT NOT NULL        -- values of the active domain profile (shared/domain-profile.ts); generic: planes (plans) | trabajo (work) | finanzas (finances) | salud (health) | viajes (travel) | otro (other)
  status TEXT NOT NULL DEFAULT 'open'  -- open | closed
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

events
  id UUID PK
  case_id UUID FK -> cases.id
  type TEXT NOT NULL            -- propuesta (proposal) | aceptación (acceptance) | rechazo (rejection) | cambio_horario (schedule change) | discusión (discussion) | acuerdo (agreement) | cancelación (cancellation) | actividad (activity)
  occurred_at TIMESTAMPTZ NOT NULL
  created_at TIMESTAMPTZ

event_messages                  -- bridge table: an Event can be backed by several Messages (SI-014)
  event_id UUID FK -> events.id
  message_id UUID FK -> messages.id
  PRIMARY KEY (event_id, message_id)

insights
  id UUID PK
  case_id UUID FK -> cases.id
  statement TEXT NOT NULL
  confidence NUMERIC(3,2) NOT NULL   -- 0.00–1.00, mandatory (SI-025)
  derived_from_event_ids UUID[] NOT NULL
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

relationships
  id UUID PK
  case_id UUID FK -> cases.id
  subject_type TEXT NOT NULL    -- Person | Place | Event | ...
  subject_id UUID NOT NULL
  predicate TEXT NOT NULL       -- "propone" (proposes), "relacionado_con" (related to), "derivado_de" (derived from), ...
  object_type TEXT NOT NULL
  object_id UUID NOT NULL
  created_at TIMESTAMPTZ
```

`insights` and `relationships` are never hidden with a soft delete: if they
are regenerated, the previous row is either kept versioned (see the
`analyses` table below) or explicitly replaced with an audit entry (SEC-005).

---

## Extracted entities (part of the Conversation Aggregate, via Message)

```sql
message_entities
  id UUID PK
  message_id UUID FK -> messages.id
  entity_type TEXT NOT NULL     -- persona (person) | lugar (place) | fecha (date) | hora (time) | institución (institution) | actividad (activity) | dinero (money)
  value TEXT NOT NULL
  normalized_value TEXT NULL
  created_at TIMESTAMPTZ
```

It is not an Aggregate of its own (there is no `EntityRepository`, per
[`AGGREGATES.md`](AGGREGATES.md)): it is managed through `Message`, within the
`Conversation` Aggregate.

---

## Extracted metadata (part of the Conversation Aggregate, via Message)

Pipeline 3 — Metadata Extraction ([`PIPELINES.md`](PIPELINES.md)) produces
language, length, type, emojis, mentions, whether the message is a reply to
another one, and presence of attachments. Of those seven, **four are already
covered** by existing columns/tables and are not duplicated here: length
(derivable from `messages.content`), type (`messages.kind`), reply to another
message (`messages.reply_to_message_id`) and presence of attachments
(`attachments`). **Language, emojis and mentions** had no table:

```sql
message_metadata
  id UUID PK
  message_id UUID NOT NULL UNIQUE FK -> messages.id   -- 1:1 with Message
  language TEXT NULL            -- ISO 639-1 ("es","fr"...); NULL if it could not be determined (very short message, emoji only, or kind != 'text')
  emoji_count INT NOT NULL DEFAULT 0
  emojis TEXT[] NOT NULL DEFAULT '{}'                  -- emojis found, in order of appearance, with repetition
  mentioned_participant_ids UUID[] NOT NULL DEFAULT '{}'  -- Participant.id mentioned in the text (logical FK; Postgres does not support FKs over array columns)
  mentioned_raw_names TEXT[] NOT NULL DEFAULT '{}'     -- detected names that do NOT match any registered Participant
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
```

**Why its own table and not columns in `messages`:** `messages` is immutable
evidence (SI-002/003/043) and Metadata Extraction runs asynchronously after
Pipeline 1/2 (Persist Evidence) — it cannot fill columns in a row that already
exists without violating "never `UPDATE` on `messages`".

**Why it does not follow the `message_entities` pattern exactly:**
`message_entities` is naturally 0:N (a message can have zero or several
entities of the same or different type) and carries no `updated_at` —
reprocessing means deleting and re-inserting its rows. `message_metadata` is
1:1 per Message (there is always exactly one row of structural metadata per
processed message). With that shape, an in-place `UPDATE` of the existing row
(`updated_at`) is simpler and introduces no ambiguity about "which row is the
current one" — unlike `analyses`, which does need `superseded_by` because
there can be several rows per `subject_id` + `dimension` at once. It is the
same pattern already used by `cases`/`insights`/`reminders` (regenerable +
`updated_at`, no versioning chain).

**Why it carries no `model`/`prompt_version` (unlike `analyses`,
SI-019/SI-020):** Metadata Extraction is defined as deterministic, with no AI
— it is not an `Analysis` in the sense of
[`AGGREGATES.md`](AGGREGATES.md)/[`SYSTEM_INVARIANTS.md`](SYSTEM_INVARIANTS.md)
(those fields exist so that an AI interpretation is auditable/reproducible;
they do not apply here). If language detection moves to AI in the future,
revisit this decision.

It is not an Aggregate of its own (there is no `MessageMetadataRepository`,
per [`AGGREGATES.md`](AGGREGATES.md)): it is managed through `Message`, like
`message_entities`. It is regenerable (SI-044) by re-running Pipeline 3
(PL-003) — it does not go through Pipeline 13 (Reprocessing), which is defined
only for `Analysis`/`Observation`/`Summary`/`Insight`/`Embedding`.

Privacy note: `mentioned_raw_names` may contain the name of third parties if
they are mentioned by name in the text — the same sensitivity level that
`messages.content` already has today; it is not new information, only
extracted from content that already lives in the database.

---

## General Pipeline state (not an Aggregate, not evidence)

```sql
message_processing_state
  message_id UUID PK FK -> messages.id   -- 1:1 with Message
  status TEXT NOT NULL DEFAULT 'PERSISTED'  -- PERSISTED | METADATA_READY | ENTITY_READY | EVENT_READY | CASE_READY | INSIGHT_READY | SUMMARY_READY | EMBEDDED | INDEXED | READY (PIPELINES.md)
  updated_at TIMESTAMPTZ NOT NULL
```

[`PIPELINES.md`](PIPELINES.md), section "Processing states", defines a
progression of 12 states per message. That progression cannot live in
`messages.status`: it would contradict SI-002 (`messages` is immutable, never
an `UPDATE`). `messages.status` stays fixed at `NEW | IMPORTED | PERSISTED`
(written once at insert time); the rest of the progression lives here.

**Why a dedicated tracking table and not "state derived from the presence of
rows"** (e.g. "does a row exist in `message_metadata`? → `METADATA_READY`"):
it works for stages with guaranteed 1:1 output (`message_metadata`, and later
`embeddings`), but **not** for stages with 0:N output where "found nothing" is
a valid result: Entity Detection (`message_entities`) and Event Detection
(`events` via `event_messages`) may legitimately produce no rows for a
message. Without an explicit marker, that is indistinguishable from "not
processed yet" — it would break idempotency (PL-004) and leave messages being
reprocessed indefinitely. A dedicated tracking table, where each stage
explicitly marks that it ran, solves this uniformly for the 8 stages of the
General Pipeline with no per-stage special cases.

**Why it is not evidence:** it is not in the list of `conversations` /
`participants` / `messages` / `attachments` (SI-002/003/043) — it is derived
knowledge about processing progress, it is updated in place (`updated_at`)
like `cases`/`insights`/`reminders`, and it is regenerable (reprocessing a
stage rolls back or repeats its state marker). It is not managed from
`Message` like `message_entities`/`message_metadata` (those are indeed "part
of the Conversation Aggregate"); this table exists outside any Aggregate
because it describes the meta-state of a process, not an interpretation of
content.

It is not an Aggregate of its own and has no repository under that name — it
is managed by the code of each Processing/Knowledge Layer stage that reads and
updates it.

---

## Derived artifacts (no Aggregate Root, no repository of their own)

`Analysis`, `Observation`, `Summary` and `Embedding` **are not Aggregates**.
They are modeled with a polymorphic reference to the object they interpret
(`subject_type` + `subject_id`), and always versioned.

```sql
analyses
  id UUID PK
  subject_type TEXT NOT NULL    -- Conversation | Message | Case | Event
  subject_id UUID NOT NULL
  dimension TEXT NOT NULL       -- one of profile.analysisDimensions; generic: formalidad (formality) | cordialidad (cordiality) | tensión (tension) | cooperación (cooperation)
  score NUMERIC(3,2) NOT NULL
  confidence NUMERIC(3,2) NOT NULL
  model TEXT NOT NULL           -- SI-019
  prompt_version TEXT NOT NULL  -- SI-020
  generated_at TIMESTAMPTZ NOT NULL  -- SI-021
  superseded_by UUID NULL FK -> analyses.id   -- versioning: never overwritten (Governance Layer)

observations
  id UUID PK
  subject_type TEXT NOT NULL
  subject_id UUID NOT NULL
  statement TEXT NOT NULL
  promoted_to_insight_id UUID NULL FK -> insights.id
  model TEXT NOT NULL
  generated_at TIMESTAMPTZ NOT NULL

summaries
  id UUID PK
  scope TEXT NOT NULL           -- day | week | month | case | conversation
  subject_type TEXT NOT NULL    -- Case | Conversation
  subject_id UUID NOT NULL
  period_start TIMESTAMPTZ NULL
  period_end TIMESTAMPTZ NULL
  content TEXT NOT NULL
  model TEXT NOT NULL
  prompt_version TEXT NOT NULL
  generated_at TIMESTAMPTZ NOT NULL

embeddings
  id UUID PK
  subject_type TEXT NOT NULL    -- Message | Event | Case | Insight | Summary
  subject_id UUID NOT NULL
  model TEXT NOT NULL
  dims INT NOT NULL
  vector VECTOR(1024) NOT NULL  -- pgvector; default model voyage-3-large @ 1024 dims
  generated_at TIMESTAMPTZ NOT NULL
```

An `hnsw (vector vector_cosine_ops)` index over `embeddings.vector` serves
Semantic Search (Q-SEM-01/02) — `hnsw` was chosen over `ivfflat` because it
needs no `lists` parameter calibrated to the table size, and the table starts
empty and grows; pgvector 0.8.x (the project image, `docker-compose.yml`)
has supported it for several versions (minimum 0.5.0). In addition, a B-tree
index over `(subject_type, model, dims)` for the filter that decides which
embedding generation is the current one. None of these four tables has
restricted `DELETE`: they are regenerable by definition (SI-022, SI-023,
SI-028, SI-029).

**Regeneration when changing model (SI-028) — `model`/`dims` are already part
of the schema, they do not need to be added:** an `embeddings` row is never
`UPDATE`d; a new one is always inserted. The "current version" is not decided
with a `superseded_by` column (unlike `analyses`) but operationally, by
whatever `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` point to in `.env`: every
Semantic Search query filters `WHERE model = :configModel AND dims =
:configDims`. Two nuances:

* **Changing model while keeping the same dimension** (e.g. `voyage-3-large`
  → `voyage-3.5-large`, both at 1024) needs no migration: the rows of both
  generations coexist in the table, distinguished by `model`, and the "old"
  rows simply become invisible to Semantic Search until they are manually
  deleted (freely, SI-029) or left unused.
* **Changing the dimension** does require a migration: the `vector` column
  has a fixed dimension (`VECTOR(1024)`), so all rows must match. The
  migration truncates `embeddings` (regenerable by definition, it touches
  neither `messages` nor any evidence table) and alters the column to the new
  width; then the full Embedding Generation is run again with the new model.

---

## Assistant (Reminder is an Aggregate Root; Draft/Suggestion have no formal Aggregate Root yet)

```sql
reminders
  id UUID PK
  conversation_id UUID FK -> conversations.id
  case_id UUID NULL FK -> cases.id
  event_id UUID NULL FK -> events.id
  due_at TIMESTAMPTZ NOT NULL
  status TEXT NOT NULL DEFAULT 'pending'  -- pending | completed | postponed | cancelled
  requires_approval BOOLEAN NOT NULL DEFAULT true
  approved_at TIMESTAMPTZ NULL
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

drafts
  id UUID PK
  conversation_id UUID FK -> conversations.id
  case_id UUID NULL FK -> cases.id
  content TEXT NOT NULL
  status TEXT NOT NULL DEFAULT 'proposed'  -- proposed | approved | discarded
  model TEXT NOT NULL
  created_at TIMESTAMPTZ

suggestions
  id UUID PK
  conversation_id UUID FK -> conversations.id
  draft_id UUID NULL FK -> drafts.id
  content TEXT NOT NULL
  created_at TIMESTAMPTZ
```

**Open note:** [`AGGREGATES.md`](AGGREGATES.md) does not define an Aggregate
Root for `Draft` or `Suggestion`. Here they are modeled as independent tables
with a direct FK to `Conversation` (and optionally `Case`) until that decision
is formalized. If it is resolved that both belong to the `Reminder` Aggregate
or to a new one (`AssistantAction`), this schema must be adjusted — that is a
domain-modeling decision, not a physical-schema one.

---

## Auditing (Governance Layer)

```sql
system_audit_log
  id UUID PK
  occurred_at TIMESTAMPTZ NOT NULL
  actor TEXT NOT NULL           -- "user" | name of the pipeline/process
  operation TEXT NOT NULL
  resource_type TEXT NOT NULL
  resource_id UUID NULL
  result TEXT NOT NULL          -- success | failure
  details JSONB NULL
```

It is never deleted (see [`SECURITY.md`](SECURITY.md): never delete audit
records).

---

## Relationship with AGGREGATES.md

```text
Conversation (root)
  ├── participants
  ├── messages
  │     ├── attachments
  │     ├── message_entities
  │     └── message_metadata
  └── (referenced by) import_jobs, cases, reminders, drafts, suggestions

Case (root)
  ├── events (── event_messages ──> messages)
  ├── insights
  └── relationships

Reminder (root)
ImportJob (root) ── sources

analyses / observations / summaries / embeddings
  → polymorphic reference to an existing Aggregate, never a repository of their own

message_processing_state
  → outside any Aggregate; 1:1 with messages.id, pipeline meta-state,
    not an interpretation of content
```

---

## Goal

To serve as the single bridge between [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) /
[`AGGREGATES.md`](AGGREGATES.md) (business language) and the implementation on
PostgreSQL + pgvector, without introducing or contradicting consistency rules
already defined in those documents.
