# QUERY_CATALOG.md

# Conversation Memory Assistant

## Propósito

Este documento existía vacío. Lo completo catalogando las consultas concretas que el Search Layer (`ARCHITECTURE.md`) debe soportar, mapeadas a los casos de uso de `USE_CASES.md` y a las tablas de `DATA_MODEL.md`.

Sirve como contrato entre el Agent Layer y el Search Layer: el agente nunca construye SQL/vector queries ad-hoc (SI-041, "El Assistant utiliza exclusivamente el Search Layer"); siempre invoca una de las consultas catalogadas aquí.

---

## Convención de nombres

`Q-<TIPO>-<NÚMERO>`, donde `TIPO` coincide con los cinco tipos de búsqueda de `ARCHITECTURE.md`: `EX` (Exact), `SEM` (Semantic), `TL` (Timeline), `CS` (Case), `EV` (Evidence). Se añaden dos tipos compuestos que ya usan los casos de uso pero no encajan en uno solo: `ST` (Statistics) y `QA` (Question Answering, compone varias de las anteriores).

---

## Exact Search

### Q-EX-01 — Mensaje por fecha exacta
UC-003. Entrada: fecha (+ opcional hora). Tabla: `messages(sent_at)`. Salida: mensaje(s) de esa fecha, evidencia original.

### Q-EX-02 — Mensajes por texto literal
UC-004. Entrada: cadena de texto. Tabla: `messages` vía índice `GIN(to_tsvector(content))`. Salida: mensajes que contienen el texto, ordenados por fecha.

### Q-EX-03 — Mensajes por participante
UC-004, UC-022. Entrada: `participant_id`. Tabla: `messages(participant_id)`. Salida: mensajes de ese participante, paginados por fecha.

### Q-EX-04 — Mensajes por rango de fechas
UC-004, UC-012. Entrada: `date_from`, `date_to`. Tabla: `messages(sent_at)`. Salida: mensajes en el rango.

---

## Semantic Search

### Q-SEM-01 — Mensajes semánticamente similares a una consulta
UC-005. Entrada: texto en lenguaje natural → embedding de consulta. Tabla: `embeddings` (`subject_type = 'Message'`) vía índice `ivfflat`/`hnsw`. Salida: mensajes ordenados por similitud (top-k configurado en la skill `rag-retrieval`).

### Q-SEM-02 — Cases relacionados semánticamente con un tema
UC-005, UC-011. Entrada: texto libre. Tabla: `embeddings` (`subject_type = 'Case'`). Salida: Cases ordenados por relevancia.

**Regla SI-036:** el resultado de Q-SEM-01/02 nunca sustituye a Q-EX-*; si el usuario pide algo literal ("el mensaje del 12 de marzo"), se usa Exact Search aunque Semantic Search también pudiera responder.

---

## Timeline Search

### Q-TL-01 — Eventos ordenados cronológicamente en un rango
UC-012. Entrada: `date_from`, `date_to` (o "última semana"/"último mes" resuelto antes de llegar aquí). Tabla: `events(occurred_at)`. Salida: eventos ordenados, con `case_id` asociado.

### Q-TL-02 — Cronología completa de un Case
UC-011, UC-012. Entrada: `case_id`. Tabla: `events` filtrado por `case_id`, ordenado por `occurred_at`. Salida: línea de tiempo del Case.

### Q-TL-03 — Actividad de un participante en el tiempo
UC-022. Entrada: `participant_id`. Tablas: `messages`, `event_messages`, `events`. Salida: cronología combinada de mensajes y eventos donde participó.

---

## Case Search

### Q-CS-01 — Toda la información de un Case
UC-011. Entrada: `case_id`. Tablas: `cases`, `events`, `insights`, `relationships`, `summaries` (`subject_type='Case'`). Salida: paquete completo (eventos + insights + resúmenes + evidencia vía Q-EV-02).

### Q-CS-02 — Cases abiertos
UC-023. Tabla: `cases(status='open')`. Salida: lista de Cases abiertos con conteo de eventos.

### Q-CS-03 — Cases por categoría
UC-011, UC-023. Entrada: `category` (valores del perfil de dominio activo, `shared/domain-profile.ts`). Tabla: `cases(category)`.

---

## Evidence Search

### Q-EV-01 — Evidencia detrás de un Insight
UC-013, UC-019. Entrada: `insight_id`. Tabla: `insights.derived_from_event_ids` → `event_messages` → `messages`. Salida: mensajes originales que sustentan el Insight. **Nunca** devuelve el Insight sin su evidencia (SI-015, SI-024).

### Q-EV-02 — Evidencia detrás de un Event
UC-013. Entrada: `event_id`. Tabla: `event_messages` → `messages`. Salida: mensajes originales.

### Q-EV-03 — Evidencia detrás de un Analysis
UC-019. Entrada: `analysis_id`. Tabla: `analyses(subject_type, subject_id)` → resuelve al mensaje/evento/case correspondiente. Salida: evidencia + `confidence` + `model` (SI-024, SI-025).

---

## Statistics

### Q-ST-01 — Estadísticas generales de la conversación
UC-023. Tablas: `messages` (count), `events` (count), `cases(status='open')` (count), `reminders(status='pending')` (count), `messages GROUP BY participant_id` (distribución). Se sirve desde el Knowledge Layer, no recorre el historial completo (evita recomputar sobre evidencia cruda cada vez).

---

## Question Answering (compuesta)

### Q-QA-01 — Responder pregunta en lenguaje natural
UC-014. Implementa el Pipeline 12 de `PIPELINES.md` (Intent Detection → Query Planning → Evidence Retrieval → Knowledge Retrieval → Context Assembly → LLM → Evidence Validation → Response). Internamente compone una o varias de las consultas anteriores según el intent detectado:

* Intent "buscar mensaje" → Q-EX-*
* Intent "buscar por tema" → Q-SEM-*
* Intent "cronología" → Q-TL-*
* Intent "sobre un Case" → Q-CS-*

La respuesta final siempre debe poder trazarse a Q-EV-01/02/03 (SI-037: "Toda respuesta debe poder reconstruirse desde la evidencia").

---

## Consultas sin dueño claro todavía

Detección de patrones (UC-015, "frecuencia de conflictos", "horarios habituales") no tiene una consulta dedicada: hoy se resolvería agregando sobre `events.type` y `analyses.dimension`, pero al ser Segunda Versión (`USE_CASES.md`) no se define su forma final aquí para no fijar un contrato prematuro. Cuando se implemente UC-015, añadir `Q-PT-01` en esta sección.

---

## Objetivo

Que ninguna consulta al historial pase por texto libre pegado al contexto de Claude ni por SQL improvisado dentro del Agent Layer: toda recuperación de información pasa por una entrada catalogada aquí, tal como exige `rules/agents-and-context.md` en la configuración de Claude Code.
