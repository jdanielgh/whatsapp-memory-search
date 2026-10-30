# PIPELINES.md

[Español](../PIPELINES.md) · **English**

# Conversation Memory Assistant

## Purpose

This document defines the system's processing pipelines.

A pipeline is a sequence of steps run to transform evidence into knowledge.

Pipelines are deterministic, asynchronous and idempotent.

---

# Principles

## PL-001

All evidence is persisted before being processed.

---

## PL-002

No pipeline modifies the evidence.

---

## PL-003

Each stage must be re-runnable independently.

---

## PL-004

Each stage must be idempotent.

Running the same pipeline multiple times produces the same result.

---

## PL-005

Each stage records an audit entry.

---

# General Pipeline

```text
Message
    │
    ▼
Persist Evidence
    │
    ▼
Metadata Extraction
    │
    ▼
Entity Detection
    │
    ▼
Event Detection
    │
    ▼
Case Resolution
    │
    ▼
Relationship Detection
    │
    ▼
Insight Generation
    │
    ▼
Summary Generation
    │
    ▼
Embedding Generation
    │
    ▼
Indexing
    │
    ▼
Ready
```

---

# Pipeline 1 - Import

## Input

File exported from WhatsApp.

## Flow

1. Validate the file.
2. Create an ImportJob.
3. Create the Conversation if it does not exist.
4. Register the Participants.
5. Register the Messages.
6. Register the Attachments.
7. Mark the evidence as persisted.
8. Send the messages to the General Pipeline.

## Output

Conversation fully stored.

---

# Pipeline 2 - Sync

## Input

New messages.

## Flow

1. Detect new messages.
2. Avoid duplicates.
3. Persist the evidence.
4. Run the General Pipeline.

---

# Pipeline 3 - Metadata Extraction

## Goal

Extract structural information from the message.

## Produces

* language
* length
* type
* emojis
* mentions
* reply to another message
* presence of attachments

---

# Pipeline 4 - Entity Detection

## Goal

Detect the entities mentioned.

## Produces

* People
* Places
* Dates
* Times
* Organizations
* Amounts
* Phone numbers
* Email addresses

Each entity stays associated with the Message.

---

# Pipeline 5 - Event Detection

## Goal

Detect the domain's relevant events.

## Examples

The event type values are stored in Spanish (see
[`DATA_MODEL.md`](DATA_MODEL.md)); the English gloss is given in parentheses.

* propuesta (proposal)
* aceptación (acceptance)
* rechazo (rejection)
* acuerdo (agreement)
* cancelación (cancellation)
* cambio (change)
* recordatorio (reminder)
* conflicto (conflict)

Produces:

* Event
* Analysis
* Observation

---

# Pipeline 6 - Case Resolution

## Goal

Determine whether the Event belongs to an existing Case.

## Flow

1. Look for related Cases.
2. Compute similarity.
3. Associate the Event.
4. Create a new Case if appropriate.

Produces:

* Existing Case updated

or

* New Case

---

# Pipeline 7 - Relationship Detection

## Goal

Build relationships between entities.

Examples:

Person

↓

Proposes

↓

Meeting

Place

↓

Related to

↓

Office

Produces:

Relationship.

---

# Pipeline 8 - Insight Generation

## Goal

Turn multiple events into knowledge.

Examples

* Frequent schedule changes.
* High cooperation.
* Recurring conflicts.
* Recurring topic.

Produces:

Insight.

---

# Pipeline 9 - Summary Generation

## Goal

Generate summaries.

Types

* Daily
* Weekly
* Monthly
* By Case
* Conversation

Produces:

Summary.

---

# Pipeline 10 - Embedding Generation

## Goal

Generate vector representations.

Supported objects

* Message
* Event
* Case
* Insight
* Summary

Produces:

Embedding.

---

# Pipeline 11 - Indexing

## Goal

Update the search indexes.

Updates

* Full Text Search
* Vector Search
* Temporal indexes
* Entity indexes

Produces

A system ready for queries.

---

# Pipeline 12 - Query Processing

## Input

User query.

## Flow

```text
User Query
      │
      ▼
Intent Detection
      │
      ▼
Query Planning
      │
      ▼
Evidence Retrieval
      │
      ▼
Knowledge Retrieval
      │
      ▼
Context Assembly
      │
      ▼
LLM
      │
      ▼
Evidence Validation
      │
      ▼
Response
```

---

# Pipeline 13 - Reprocessing

## Goal

Update derived artifacts using new models.

It runs on:

* Analysis
* Observation
* Summary
* Insight
* Embedding

Never on:

* Message
* Participant
* Conversation
* Attachment

---

# Pipeline 14 - Reminder Processing

## Flow

1. Create a Reminder.
2. Validate the references.
3. Record the state.
4. Wait for future execution.

---

# Pipeline 15 - Draft Generation

## Flow

1. Retrieve context.
2. Retrieve evidence.
3. Retrieve Insights.
4. Build the prompt.
5. Generate the draft.
6. Wait for the user's approval.

Never send automatically.

---

# Processing states

This progression lives in `message_processing_state.status`
(`DATA_MODEL.md`), not in `messages.status`: `messages` is immutable
evidence (SI-002) and only goes as far as `PERSISTED` (set once, at insert
time). Each stage explicitly marks its state when it finishes — even if it
produced no rows in the corresponding knowledge table (Entity/Event Detection
may legitimately find nothing), so that "no results" is distinguishable from
"not processed yet".

```text
NEW

↓

IMPORTED

↓

PERSISTED

↓

METADATA_READY

↓

ENTITY_READY

↓

EVENT_READY

↓

CASE_READY

↓

INSIGHT_READY

↓

SUMMARY_READY

↓

EMBEDDED

↓

INDEXED

↓

READY
```

---

# Failure recovery

If a stage fails:

* no evidence is deleted
* the whole pipeline is not restarted
* only the failed stage is reprocessed

---

# Auditing

Each run records:

* pipeline
* stage
* date
* duration
* version
* model used
* result
* errors

---

# Dependencies

```text
Import
    │
    ▼
Persist
    │
    ▼
Metadata
    │
    ▼
Entities
    │
    ▼
Events
    │
    ▼
Cases
    │
    ▼
Relationships
    │
    ▼
Insights
    │
    ▼
Summaries
    │
    ▼
Embeddings
    │
    ▼
Indexes
```

A stage never depends on a later stage.

---

# Goal

To transform immutable evidence into structured knowledge through a sequence
of independent, auditable, reproducible and regenerable processes, ensuring
the system can evolve without compromising the integrity of the original
conversation.
