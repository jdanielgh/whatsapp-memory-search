# DATA_MODEL.md

# Conversation Memory Assistant

## Nota de corrección

Este archivo contenía previamente una copia de `AGGREGATES.md` con una versión desactualizada y contradictoria (definía `Analysis` como Aggregate Root con repositorio propio). Eso viola `AGGREGATES.md` y `DOMAIN_MODEL.md`, que tratan `Analysis`, `Observation`, `Summary` y `Embedding` como **artefactos derivados sin repositorio propio**. Este documento se reescribe desde cero como lo que su nombre indica: el modelo de datos a nivel de esquema (tablas, columnas, tipos, índices), no una redefinición de los Aggregates. Para límites de consistencia y Aggregate Roots, la referencia sigue siendo `AGGREGATES.md`.

---

## Propósito

Este documento traduce `DOMAIN_MODEL.md` y `AGGREGATES.md` a un esquema físico concreto sobre **PostgreSQL + pgvector** (decisión ya fijada en `ARCHITECTURE.md`).

No introduce conceptos de negocio nuevos. Cada tabla corresponde a una entidad ya definida en `UBIQUITOUS_LANGUAGE.md`.

---

## Convenciones

* Nombres de entidad del dominio: singular (`Message`). Nombres de tabla: plural en `snake_case` (`messages`). Es la única traducción permitida entre lenguaje ubicuo y esquema físico.
* Toda tabla tiene `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — identificador único e inmutable (SI-042).
* Toda tabla registra `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
* Ninguna tabla de evidencia (`conversations`, `participants`, `messages`, `attachments`) tiene columna `updated_at` ni `deleted_at`: la evidencia no se actualiza ni usa soft delete (SI-002, SI-003, SI-043).
* Las tablas de conocimiento y de artefactos derivados sí pueden tener `updated_at` porque son regenerables.
* Claves foráneas entre Aggregates distintos se guardan como UUID simple, nunca como referencia de objeto (AG-003).

---

## Evidencia (Aggregate: Conversation)

```sql
conversations
  id UUID PK
  title TEXT NULL
  created_at TIMESTAMPTZ

participants
  id UUID PK
  conversation_id UUID FK -> conversations.id
  display_name TEXT NOT NULL
  role TEXT NOT NULL            -- etiqueta libre, ej. "organizador" | "miembro" | "sistema"
  created_at TIMESTAMPTZ

messages
  id UUID PK
  conversation_id UUID FK -> conversations.id
  participant_id UUID FK -> participants.id
  sent_at TIMESTAMPTZ NOT NULL
  content TEXT NOT NULL
  kind TEXT NOT NULL DEFAULT 'text'  -- text | call | system (ver nota "Clasificación de líneas" abajo)
  deleted_by_sender BOOLEAN NOT NULL DEFAULT false  -- true si WhatsApp ya solo exportó el placeholder de borrado
  raw_source TEXT NOT NULL      -- línea original del export, para auditoría de parseo
  reply_to_message_id UUID NULL FK -> messages.id
  status TEXT NOT NULL          -- NEW | IMPORTED | PERSISTED (se fija una sola vez al insertar, nunca se actualiza — ver nota "Estado del Pipeline General" abajo)
  content_hash TEXT NOT NULL    -- hash de integridad (ver SECURITY.md "Integridad")
  created_at TIMESTAMPTZ
  -- sin updated_at / sin deleted_at: inmutable, sin soft delete.
  -- `deleted_by_sender` NO es soft delete del sistema (SI-043 intacto):
  -- registra un hecho ocurrido en WhatsApp antes de la importación. El
  -- `content` en ese caso es el placeholder textual que WhatsApp exportó
  -- ("Se eliminó este mensaje"), nunca contenido inventado o recuperado.

attachments
  id UUID PK
  message_id UUID FK -> messages.id
  type TEXT NOT NULL            -- imagen | audio | video | documento | sticker
  status TEXT NOT NULL DEFAULT 'unavailable'  -- available | unavailable
  storage_path TEXT NULL        -- NULL si status = unavailable
  file_hash TEXT NULL           -- NULL si status = unavailable
  created_at TIMESTAMPTZ
  -- Un export de solo texto (._chat.txt sin carpeta de medios) referencia
  -- adjuntos ("‎imagen omitida", etc.) sin que exista el archivo real.
  -- Esa fila se crea igual (para no perder el hecho de que hubo un
  -- adjunto), con status='unavailable' y sin path/hash. Si en el futuro
  -- se importa el mismo período desde un export con medios, esa fila se
  -- puede completar (status='available' + path + hash) sin duplicar el
  -- Message al que pertenece.

sources
  id UUID PK
  type TEXT NOT NULL            -- whatsapp_export | whatsapp_live (futuro)
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

Índices: `messages(conversation_id, sent_at)`, `messages(participant_id)`, índice `GIN` sobre `to_tsvector('spanish', content)` para Exact Search por texto.

### Clasificación de líneas (`messages.kind`)

Un export real de WhatsApp mezcla, con el mismo formato de línea
`[fecha, hora] Nombre: ...`, tres cosas distintas. Se distinguen durante
el parseo del export (Pipeline 1 / Persist Evidence, `whatsapp-parser.ts`),
no en Metadata Extraction (Pipeline 3): `messages.kind` es `NOT NULL`
desde el insert y `messages` es inmutable (SI-002, sin `UPDATE` jamás),
así que tiene que quedar resuelto antes de persistir la fila, no después
de forma asíncrona. Se persisten en `messages.kind`:

* `text` — mensaje escrito por un participante. Caso por defecto.
* `call` — línea generada por WhatsApp para una llamada de voz/video
  ("Llamada perdida", "Videollamada"). No es Event Detection (Pipeline 5)
  todavía — es solo clasificación estructural; si más adelante se decide
  modelar llamadas como `Event`, parte de aquí.
* `system` — avisos generados por WhatsApp, no por un participante (aviso
  de cifrado al inicio del export, cambios de grupo si los hubiera). El
  `Participant` asociado puede no representar a una persona real — ver
  `whatsapp-ingest`, nota sobre Participant "Sistema".

`deleted_by_sender = true` es ortogonal a `kind` (hoy solo se observa en
`kind = 'text'`): el `content` es el placeholder que WhatsApp exportó, no
el mensaje original — WhatsApp ya no lo conserva en el momento del
export, así que el sistema tampoco puede reconstruirlo.

---

## Conocimiento (Aggregate: Case)

```sql
cases
  id UUID PK
  conversation_id UUID FK -> conversations.id
  title TEXT NOT NULL
  category TEXT NOT NULL        -- valores del perfil de dominio activo (shared/domain-profile.ts); genérico: planes | trabajo | finanzas | salud | viajes | otro
  status TEXT NOT NULL DEFAULT 'open'  -- open | closed
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

events
  id UUID PK
  case_id UUID FK -> cases.id
  type TEXT NOT NULL            -- propuesta | aceptación | rechazo | cambio_horario | discusión | acuerdo | cancelación | actividad
  occurred_at TIMESTAMPTZ NOT NULL
  created_at TIMESTAMPTZ

event_messages                  -- tabla puente: un Event puede respaldarse en varios Message (SI-014)
  event_id UUID FK -> events.id
  message_id UUID FK -> messages.id
  PRIMARY KEY (event_id, message_id)

insights
  id UUID PK
  case_id UUID FK -> cases.id
  statement TEXT NOT NULL
  confidence NUMERIC(3,2) NOT NULL   -- 0.00–1.00, obligatorio (SI-025)
  derived_from_event_ids UUID[] NOT NULL
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

relationships
  id UUID PK
  case_id UUID FK -> cases.id
  subject_type TEXT NOT NULL    -- Person | Place | Event | ...
  subject_id UUID NOT NULL
  predicate TEXT NOT NULL       -- "propone", "relacionado_con", "derivado_de", ...
  object_type TEXT NOT NULL
  object_id UUID NOT NULL
  created_at TIMESTAMPTZ
```

`insights` e `relationships` nunca se marcan con soft delete oculto: si se regeneran, la fila anterior se conserva versionada (ver más abajo, tabla `analyses`) o se reemplaza explícitamente con auditoría (SEC-005).

---

## Entidades extraídas (parte del Aggregate Conversation, vía Message)

```sql
message_entities
  id UUID PK
  message_id UUID FK -> messages.id
  entity_type TEXT NOT NULL     -- persona | lugar | fecha | hora | institución | actividad | dinero
  value TEXT NOT NULL
  normalized_value TEXT NULL
  created_at TIMESTAMPTZ
```

No es un Aggregate propio (no hay `EntityRepository`, per AGGREGATES.md): se administra a través de `Message`, dentro del Aggregate `Conversation`.

---

## Metadata extraída (parte del Aggregate Conversation, vía Message)

Pipeline 3 — Metadata Extraction (`docs/PIPELINES.md`) produce idioma,
longitud, tipo, emojis, menciones, si es respuesta a otro mensaje y
presencia de adjuntos. De esos siete, **cuatro ya están cubiertos** por
columnas/tablas existentes y no se duplican aquí: longitud (derivable de
`messages.content`), tipo (`messages.kind`), respuesta a otro mensaje
(`messages.reply_to_message_id`) y presencia de adjuntos (`attachments`).
Faltan **idioma, emojis y menciones** — no tenían tabla:

```sql
message_metadata
  id UUID PK
  message_id UUID NOT NULL UNIQUE FK -> messages.id   -- 1:1 con Message
  language TEXT NULL            -- ISO 639-1 ("es","fr"...); NULL si no se pudo determinar (mensaje muy corto, solo emoji, o kind != 'text')
  emoji_count INT NOT NULL DEFAULT 0
  emojis TEXT[] NOT NULL DEFAULT '{}'                  -- emojis encontrados, en orden de aparición, con repetición
  mentioned_participant_ids UUID[] NOT NULL DEFAULT '{}'  -- Participant.id mencionados en el texto (FK lógica; Postgres no soporta FK sobre columnas array)
  mentioned_raw_names TEXT[] NOT NULL DEFAULT '{}'     -- nombres detectados que NO matchean ningún Participant registrado
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
```

**Por qué tabla propia y no columnas en `messages`:** `messages` es
evidencia inmutable (SI-002/003/043) y Metadata Extraction corre async
después de Pipeline 1/2 (Persist Evidence) — no puede rellenar columnas
en una fila que ya existe sin violar "nunca `UPDATE` sobre `messages`".

**Por qué no sigue exactamente el patrón de `message_entities`:**
`message_entities` es naturalmente 0:N (un mensaje puede tener 0 o varias
entidades del mismo o distinto tipo) y no lleva `updated_at` — reprocesar
significa borrar e reinsertar sus filas. `message_metadata` es 1:1 por
Message (siempre hay exactamente una fila de metadata estructural por
mensaje procesado). Con esa forma, un `UPDATE` in place sobre la fila
existente (`updated_at`) es más simple y no introduce ambigüedad de "cuál
fila es la vigente" — a diferencia de `analyses`, que si necesita
`superseded_by` porque puede haber varias filas por `subject_id` +
`dimension` a la vez. Es el mismo patrón que ya usan `cases`/`insights`/
`reminders` (regenerable + `updated_at`, sin cadena de versionado).

**Por qué no lleva `model`/`prompt_version` (a diferencia de `analyses`,
SI-019/SI-020):** Metadata Extraction está definida como determinista,
sin IA (`plans/`) — no es un `Analysis` en el
sentido de `AGGREGATES.md`/`SYSTEM_INVARIANTS.md` (esos campos existen
para que una interpretación de IA sea auditable/reproducible; aquí no
aplica). Si en el futuro la detección de idioma pasa a IA, revisar esta
decisión.

No es un Aggregate propio (no hay `MessageMetadataRepository`, per
AGGREGATES.md): se administra a través de `Message`, igual que
`message_entities`. Es regenerable (SI-044) reejecutando Pipeline 3
(PL-003) — no pasa por el Pipeline 13 de Reprocessing, que está definido
solo para `Analysis`/`Observation`/`Summary`/`Insight`/`Embedding`.

Nota de privacidad: `mentioned_raw_names` puede contener el nombre de
terceros si se los menciona por nombre en el texto — mismo nivel de
sensibilidad que `messages.content` ya tiene hoy
(`rules/security-privacy.md` regla 2); no es información nueva, solo
extraída de contenido que ya vive en la base de datos.

---

## Estado del Pipeline General (no es Aggregate, no es evidencia)

```sql
message_processing_state
  message_id UUID PK FK -> messages.id   -- 1:1 con Message
  status TEXT NOT NULL DEFAULT 'PERSISTED'  -- PERSISTED | METADATA_READY | ENTITY_READY | EVENT_READY | CASE_READY | INSIGHT_READY | SUMMARY_READY | EMBEDDED | INDEXED | READY (docs/PIPELINES.md)
  updated_at TIMESTAMPTZ NOT NULL
```

`docs/PIPELINES.md`, sección "Estados del procesamiento", define una
progresión de 12 estados por mensaje. Antes de esta tabla, esa
progresión estaba documentada como si viviera en `messages.status` —
contradicción real con SI-002 (`messages` es inmutable, nunca se le hace
`UPDATE`) detectada al implementar Pipeline 3. `messages.status` queda
fijo en `NEW | IMPORTED | PERSISTED` (se escribe una sola vez al
insertar); el resto de la progresión vive acá.

**Por qué una tabla de tracking dedicada y no "estado derivado de
presencia de filas"** (ej. "¿existe fila en `message_metadata`? →
`METADATA_READY`"): funciona para etapas de salida 1:1 garantizada
(`message_metadata`, y más adelante `embeddings`), pero **no** para
etapas de salida 0:N donde "no encontró nada" es un resultado válido:
Entity Detection (`message_entities`) y Event Detection (`events` vía
`event_messages`) pueden legítimamente no producir ninguna fila para un
mensaje. Sin un marcador explícito, eso es indistinguible de "todavía no
procesado" — rompería idempotencia (PL-004) y dejaría mensajes
reprocesándose indefinidamente. Una tabla de tracking dedicada, donde
cada etapa marca explícitamente que corrió, resuelve esto de forma
uniforme para las 8 etapas del Pipeline General sin casos especiales por
etapa.

**Por qué no es evidencia:** no está en la lista de `conversations` /
`participants` / `messages` / `attachments` (SI-002/003/043) — es
conocimiento derivado sobre el progreso del procesamiento, se actualiza
in place (`updated_at`) como `cases`/`insights`/`reminders`, y es
regenerable (reprocesar una etapa retrocede o repite su marca de
estado). No se administra desde `Message` como `message_entities`/
`message_metadata` (esas sí son "parte del Aggregate Conversation");
esta tabla existe fuera de cualquier Aggregate porque describe
metaestado de un proceso, no una interpretación de contenido.

No es un Aggregate propio, sin repositorio propio con ese nombre — se
administra desde el código de cada etapa del Processing/Knowledge Layer
que la consulta y actualiza.

---

## Artefactos derivados (sin Aggregate Root, sin repositorio propio)

`Analysis`, `Observation`, `Summary` y `Embedding` **no son Aggregates**. Se modelan con una referencia polimórfica al objeto que interpretan (`subject_type` + `subject_id`), y siempre versionados.

```sql
analyses
  id UUID PK
  subject_type TEXT NOT NULL    -- Conversation | Message | Case | Event
  subject_id UUID NOT NULL
  dimension TEXT NOT NULL       -- una de profile.analysisDimensions; genérico: formalidad | cordialidad | tensión | cooperación
  score NUMERIC(3,2) NOT NULL
  confidence NUMERIC(3,2) NOT NULL
  model TEXT NOT NULL           -- SI-019
  prompt_version TEXT NOT NULL  -- SI-020
  generated_at TIMESTAMPTZ NOT NULL  -- SI-021
  superseded_by UUID NULL FK -> analyses.id   -- versionado: nunca se sobrescribe (Governance Layer)

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
  vector VECTOR(1024) NOT NULL  -- pgvector; voyage-3-large @ 1024 dims (docs/DECISIONS.md, "Embeddings: proveedor, modelo, chunking, top-k y regeneración")
  generated_at TIMESTAMPTZ NOT NULL
```

Índice `hnsw (vector vector_cosine_ops)` sobre `embeddings.vector` para Semantic Search (Q-SEM-01/02) — se eligió `hnsw` sobre `ivfflat` porque no necesita un parámetro `lists` calibrado al tamaño de la tabla, que hoy empieza vacía y crece; pgvector 0.8.x (imagen del proyecto, `docker-compose.yml`) lo soporta desde hace varias versiones (mínimo 0.5.0). Además, un índice B-tree sobre `(subject_type, model, dims)` para el filtro que decide qué generación de embedding es la vigente. Ninguna de estas cuatro tablas tiene `DELETE` restringido: son regenerables por definición (SI-022, SI-023, SI-028, SI-029).

**Regeneración al cambiar de modelo (SI-028) — `model`/`dims` ya son parte del esquema, no hace falta agregarlos:** nunca se hace `UPDATE` sobre una fila de `embeddings`, siempre se inserta una nueva. La "versión vigente" no se decide con una columna `superseded_by` (a diferencia de `analyses`) sino operativamente, por lo que apunte `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` en `.env`: toda consulta de Semantic Search filtra `WHERE model = :configModel AND dims = :configDims`. Dos matices:

* **Cambiar de modelo manteniendo la misma dimensión** (ej. `voyage-3-large` → `voyage-3.5-large`, ambos a 1024) no requiere migración: las filas de ambas generaciones conviven en la tabla, distinguidas por `model`, y las filas "viejas" quedan simplemente invisibles para Semantic Search hasta que se borren manualmente (libre, SI-029) o se dejen de usar.
* **Cambiar de dimensión** sí requiere migración: la columna `vector` tiene una dimensión fija (`VECTOR(1024)`), así que todas las filas deben coincidir. La migración trunca `embeddings` (regenerable por definición, no toca `messages` ni ninguna tabla de evidencia) y altera la columna al nuevo ancho; después se vuelve a correr Embedding Generation completo con el modelo nuevo.

---

## Asistente (Reminder es Aggregate Root; Draft/Suggestion aún sin Aggregate Root formal)

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

**Nota abierta:** `AGGREGATES.md` no define un Aggregate Root para `Draft` ni `Suggestion`. Aquí se modelan como tablas independientes con FK directa a `Conversation` (y opcionalmente `Case`) mientras esa decisión no se formalice. Si se resuelve que ambos pertenecen al Aggregate `Reminder` o a uno nuevo (`AssistantAction`), este esquema debe ajustarse — no lo hago unilateralmente porque es una decisión de modelado de dominio, no de esquema físico.

---

## Auditoría (Governance Layer)

```sql
system_audit_log
  id UUID PK
  occurred_at TIMESTAMPTZ NOT NULL
  actor TEXT NOT NULL           -- "user" | nombre de pipeline/proceso
  operation TEXT NOT NULL
  resource_type TEXT NOT NULL
  resource_id UUID NULL
  result TEXT NOT NULL          -- success | failure
  details JSONB NULL
```

Nunca se borra (SEC "Nunca eliminar registros de auditoría").

---

## Relación con AGGREGATES.md

```text
Conversation (root)
  ├── participants
  ├── messages
  │     ├── attachments
  │     ├── message_entities
  │     └── message_metadata
  └── (referenciado por) import_jobs, cases, reminders, drafts, suggestions

Case (root)
  ├── events (── event_messages ──> messages)
  ├── insights
  └── relationships

Reminder (root)
ImportJob (root) ── sources

analyses / observations / summaries / embeddings
  → referencia polimórfica a un Aggregate existente, nunca repositorio propio

message_processing_state
  → fuera de cualquier Aggregate; 1:1 con messages.id, metaestado de
    pipeline, no interpretación de contenido
```

---

## Objetivo

Servir de puente único entre `DOMAIN_MODEL.md` / `AGGREGATES.md` (lenguaje de negocio) y la implementación en PostgreSQL + pgvector, sin introducir ni contradecir reglas de consistencia ya definidas en esos documentos.
