# AGGREGATES.md

[Español](../AGGREGATES.md) · **English**

# WhatsApp Memory Search

## Purpose

This document defines the domain's **Aggregates** and their consistency
boundaries.

Aggregates establish:

* Which entities form a logical unit.
* Which object acts as the entry point (Aggregate Root).
* Which business rules must be kept consistent.
* How the different Aggregates relate to each other.

This document is independent of the database and of any technology used.

---

# Principles

## AG-001

Every Aggregate has exactly one **Aggregate Root**.

---

## AG-002

External consumers only interact with the Aggregate Root.

Never with the internal entities.

---

## AG-003

Aggregates relate to each other through identifiers.

Never through direct references to internal objects.

---

## AG-004

Each Aggregate is responsible for maintaining its own invariants.

---

## AG-005

Changes should stay within the same Aggregate whenever possible.

---

# Aggregate: Conversation

## Aggregate Root

**Conversation**

## Purpose

Represents a complete conversation and all of its evidence.

It is the system's main Aggregate.

## Contains

```text
Conversation
├── Participant
├── Message
└── Attachment
```

## Responsibilities

* Register participants.
* Register messages.
* Preserve the evidence.
* Guarantee the integrity of the conversation.

## Invariants

* Every Message belongs to a Conversation.
* Every Participant belongs to a Conversation.
* Every Attachment belongs to a Message.
* Messages are immutable.
* Evidence is never deleted.

## References

It can be referenced by:

* Case
* ImportJob
* Reminder

---

# Aggregate: Case

## Aggregate Root

**Case**

## Purpose

Represents a business topic that evolves over time.

Examples:

* Trip plans
* Work
* Health
* Finances
* Plans

## Contains

```text
Case
├── Event
├── Insight
└── Relationship
```

## Responsibilities

* Group related events.
* Maintain the context of the case.
* Consolidate knowledge.

## Invariants

* Every Event belongs to a single Case.
* Every Insight belongs to a single Case.
* Every Relationship belongs to a single Case.

## References

It refers to:

* Conversation

It can be referenced by:

* Reminder

---

# Aggregate: Reminder

## Aggregate Root

**Reminder**

## Purpose

Represents a future action suggested or created for the user.

## Contains

```text
Reminder
```

## Responsibilities

* Maintain the target date.
* Maintain the state.
* Maintain the user's authorization.

## Invariants

* Is never executed automatically.
* Always requires the user's approval.

## References

It can reference:

* Conversation
* Case
* Event

---

# Aggregate: ImportJob

## Aggregate Root

**ImportJob**

## Purpose

Record each import process run by the system.

## Contains

```text
ImportJob
└── Source
```

## Responsibilities

* Record the origin of the information.
* Record the date and state.
* Maintain traceability.

## Invariants

* Every ImportJob belongs to a Conversation.
* Every ImportJob has a Source.
* An import never modifies existing evidence.

---

# Derived Artifacts

The following elements **are not Aggregates**.

They are results of automatic processes and can be regenerated at any time.

* Analysis
* Observation
* Summary
* Embedding

## Rules

* They have no business identity of their own.
* They have no independent repositories.
* They always belong to an existing Aggregate.
* They never modify the evidence.
* They can be deleted and regenerated.

---

# Relationships between Aggregates

```text
Conversation
│
├── Case
│     ├── Event
│     ├── Insight
│     └── Relationship
│
├── Reminder
│
└── ImportJob
```

Aggregates relate to each other only through identifiers.

---

# Repositories

There is exactly one repository per Aggregate Root.

```text
ConversationRepository

CaseRepository

ReminderRepository

ImportJobRepository
```

There are no repositories for internal entities.

Examples:

* ❌ MessageRepository
* ❌ EventRepository
* ❌ AttachmentRepository
* ❌ InsightRepository
* ❌ RelationshipRepository

These entities are managed exclusively by their Aggregate Root.

---

# Consistency

Each Aggregate guarantees the consistency of its own entities.

Relationships between Aggregates can be resolved through references and
synchronization processes, avoiding distributed transactions whenever
possible.

---

# Goal

To maintain clear boundaries between the domain's responsibilities, reduce
coupling and allow each Aggregate to evolve independently without
compromising the integrity of the system.
