# QUERY_CATALOG.md

[Español](../QUERY_CATALOG.md) · **English**

# Conversation Memory Assistant

## Purpose

This document catalogues the concrete queries that the Search Layer
([`ARCHITECTURE.md`](ARCHITECTURE.md)) must support, mapped to the use cases
in [`USE_CASES.md`](USE_CASES.md) and to the tables in
[`DATA_MODEL.md`](DATA_MODEL.md).

It serves as a contract between the Agent Layer and the Search Layer: the
agent never builds ad-hoc SQL/vector queries (SI-041, "The Assistant uses
exclusively the Search Layer"); it always invokes one of the queries
catalogued here.

---

## Naming convention

`Q-<TYPE>-<NUMBER>`, where `TYPE` matches the five search types of
`ARCHITECTURE.md`: `EX` (Exact), `SEM` (Semantic), `TL` (Timeline), `CS`
(Case), `EV` (Evidence). Two composite types are added that use cases already
rely on but that do not fit a single one: `ST` (Statistics) and `QA`
(Question Answering, which composes several of the above).

---

## Exact Search

### Q-EX-01 — Message by exact date
UC-003. Input: date (+ optional time). Table: `messages(sent_at)`. Output: the message(s) of that date, original evidence.

### Q-EX-02 — Messages by literal text
UC-004. Input: text string. Table: `messages` through the `GIN(to_tsvector(content))` index. Output: messages containing the text, ordered by date.

### Q-EX-03 — Messages by participant
UC-004, UC-022. Input: `participant_id`. Table: `messages(participant_id)`. Output: that participant's messages, paginated by date.

### Q-EX-04 — Messages by date range
UC-004, UC-012. Input: `date_from`, `date_to`. Table: `messages(sent_at)`. Output: messages in the range.

---

## Semantic Search

### Q-SEM-01 — Messages semantically similar to a query
UC-005. Input: natural-language text → query embedding. Table: `embeddings` (`subject_type = 'Message'`) through the `ivfflat`/`hnsw` index. Output: messages ordered by similarity (top-k configured in the `rag-retrieval` skill).

### Q-SEM-02 — Cases semantically related to a topic
UC-005, UC-011. Input: free text. Table: `embeddings` (`subject_type = 'Case'`). Output: Cases ordered by relevance.

**Rule SI-036:** the result of Q-SEM-01/02 never replaces Q-EX-*; if the user asks for something literal ("the message from March 12"), Exact Search is used even if Semantic Search could also answer.

---

## Timeline Search

### Q-TL-01 — Events ordered chronologically within a range
UC-012. Input: `date_from`, `date_to` (or "last week"/"last month", resolved before reaching here). Table: `events(occurred_at)`. Output: ordered events, with the associated `case_id`.

### Q-TL-02 — Complete timeline of a Case
UC-011, UC-012. Input: `case_id`. Table: `events` filtered by `case_id`, ordered by `occurred_at`. Output: the Case's timeline.

### Q-TL-03 — A participant's activity over time
UC-022. Input: `participant_id`. Tables: `messages`, `event_messages`, `events`. Output: combined timeline of messages and events in which they took part.

---

## Case Search

### Q-CS-01 — All the information of a Case
UC-011. Input: `case_id`. Tables: `cases`, `events`, `insights`, `relationships`, `summaries` (`subject_type='Case'`). Output: complete package (events + insights + summaries + evidence through Q-EV-02).

### Q-CS-02 — Open Cases
UC-023. Table: `cases(status='open')`. Output: list of open Cases with event counts.

### Q-CS-03 — Cases by category
UC-011, UC-023. Input: `category` (values of the active domain profile, `shared/domain-profile.ts`). Table: `cases(category)`.

---

## Evidence Search

### Q-EV-01 — Evidence behind an Insight
UC-013, UC-019. Input: `insight_id`. Table: `insights.derived_from_event_ids` → `event_messages` → `messages`. Output: the original messages that support the Insight. It **never** returns the Insight without its evidence (SI-015, SI-024).

### Q-EV-02 — Evidence behind an Event
UC-013. Input: `event_id`. Table: `event_messages` → `messages`. Output: original messages.

### Q-EV-03 — Evidence behind an Analysis
UC-019. Input: `analysis_id`. Table: `analyses(subject_type, subject_id)` → resolves to the corresponding message/event/case. Output: evidence + `confidence` + `model` (SI-024, SI-025).

---

## Statistics

### Q-ST-01 — General statistics of the conversation
UC-023. Tables: `messages` (count), `events` (count), `cases(status='open')` (count), `reminders(status='pending')` (count), `messages GROUP BY participant_id` (distribution). Served from the Knowledge Layer, it does not walk the whole history (avoids recomputing over raw evidence every time).

---

## Question Answering (composite)

### Q-QA-01 — Answer a natural-language question
UC-014. Implements Pipeline 12 of [`PIPELINES.md`](PIPELINES.md) (Intent Detection → Query Planning → Evidence Retrieval → Knowledge Retrieval → Context Assembly → LLM → Evidence Validation → Response). Internally it composes one or several of the queries above depending on the detected intent:

* Intent "search message" → Q-EX-*
* Intent "search by topic" → Q-SEM-*
* Intent "timeline" → Q-TL-*
* Intent "about a Case" → Q-CS-*

The final answer must always be traceable to Q-EV-01/02/03 (SI-037: "Every answer must be reconstructible from the evidence").

---

## Queries with no clear owner yet

Pattern detection (UC-015, "frequency of conflicts", "usual times") has no dedicated query: today it would be solved by aggregating over `events.type` and `analyses.dimension`, but since it is Second Version ([`USE_CASES.md`](USE_CASES.md)) its final shape is not defined here, to avoid fixing a premature contract. When UC-015 is implemented, add `Q-PT-01` in this section.

---

## Goal

That no query to the history goes through free text pasted into Claude's context or through improvised SQL inside the Agent Layer: all information retrieval goes through an entry catalogued here, as `.claude/rules/agents-and-context.md` requires in the Claude Code configuration.
