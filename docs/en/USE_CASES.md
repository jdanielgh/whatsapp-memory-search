# USE_CASES.md

[Español](../USE_CASES.md) · **English**

# WhatsApp Memory Search

## Purpose

This document describes the system's use cases from the point of view of the
user and of the domain.

Each use case represents a capability of the system, regardless of the
interface or the technology used.

---

# Actors

## User

Owner of the conversation.

Can import information, query knowledge, manage reminders and request
assistance.

---

## System

Responsible for processing information, generating knowledge and keeping the
domain consistent.

---

# UC-001 Import a conversation

## Goal

Register a conversation exported from WhatsApp.

### Actor

User

### Preconditions

* A valid export file exists.

### Flow

1. The user selects a file.
2. The system validates the format.
3. The system creates an ImportJob.
4. The system imports the participants.
5. The system imports the messages.
6. The system registers the attachments.
7. The system starts processing.

### Result

The whole conversation is stored as evidence.

---

# UC-002 Sync new messages

## Goal

Incorporate new messages without affecting the existing evidence.

### Actor

System

### Flow

1. Detect new messages.
2. Avoid duplicates.
3. Register the evidence.
4. Run the pipeline.

### Result

The conversation stays up to date.

---

# UC-003 Look up a message

## Goal

Retrieve a specific message.

### Actor

User

### Examples

* Show the message from March 12.
* Find a specific message.

### Result

The original evidence is returned.

---

# UC-004 Search messages

## Goal

Search messages using different criteria.

### Actor

User

### Criteria

* Text
* Date
* Participant
* Range
* Keywords

### Result

A list of matching messages.

---

# UC-005 Search by similarity

## Goal

Find semantically related messages.

### Actor

User

### Examples

* Conversations about vacations.
* Messages related to the budget.

### Result

Similar messages ordered by relevance.

---

# UC-006 Detect entities

## Goal

Extract the entities present in the messages.

### Actor

System

### Examples

* People
* Places
* Dates
* Times
* Institutions
* Amounts

### Result

The entities are linked to the message.

---

# UC-007 Detect events

## Goal

Identify relevant events.

### Actor

System

### Examples

* Proposal
* Rejection
* Agreement
* Schedule change
* Discussion

### Result

An Event is recorded.

---

# UC-008 Manage Cases

## Goal

Group related events.

### Actor

System

### Flow

1. Detect a new Event.
2. Look for existing Cases.
3. Associate the Event.
4. Create a new Case if needed.

### Result

The knowledge stays organized.

---

# UC-009 Generate Insights

## Goal

Consolidate knowledge that is useful to the user.

### Actor

System

### Examples

* Behavior patterns.
* Frequency of agreements.
* Trends.
* Recurring topics.

### Result

New Insights are generated.

---

# UC-010 Generate summaries

## Goal

Summarize information.

### Actor

User

### Types

* Daily
* Weekly
* Monthly
* By Case
* Whole conversation

---

# UC-011 Query a Case

## Goal

View all the information related to a topic.

### Actor

User

### Result

The system returns:

* Events
* Evidence
* Insights
* Summaries

---

# UC-012 Query the timeline

## Goal

View events ordered in time.

### Actor

User

### Examples

* Last week.
* Last month.
* Custom range.

---

# UC-013 Query evidence

## Goal

View the evidence used to answer a query.

### Actor

User

### Result

The system returns the original messages.

---

# UC-014 Answer questions

## Goal

Answer natural-language queries.

### Actor

User

### Examples

When did they reject a meeting?

How many times did we change the schedule?

Who proposed the trip?

### Result

An answer accompanied by evidence.

---

# UC-015 Detect patterns

## Goal

Identify repetitive behaviors.

### Actor

User

### Examples

* Frequency of conflicts.
* Usual times.
* Recurring changes.

---

# UC-016 Create a reminder

## Goal

Register a future action.

### Actor

User

### Result

A Reminder is created.

---

# UC-017 Manage reminders

## Goal

Change the state of a reminder.

### Actor

User

### Actions

* Complete.
* Postpone.
* Cancel.

---

# UC-018 Generate a draft

## Goal

Draft a message.

### Actor

User

### Examples

* Friendly reply.
* Formal reply.
* Evidence-based reply.

### Result

A Draft is generated.

---

# UC-019 Explain an answer

## Goal

Show how the system reached a conclusion.

### Actor

User

### Result

The answer includes:

* Evidence.
* Events.
* Cases.
* Confidence level.

---

# UC-020 Reprocess knowledge

## Goal

Update the knowledge using new AI models.

### Actor

System

### Flow

1. Select derived artifacts.
2. Run the pipeline again.
3. Create new versions.
4. Keep the evidence intact.

---

# UC-021 Rebuild knowledge

## Goal

Fully rebuild the system's knowledge.

### Actor

System

### Result

The following are regenerated:

* Analysis
* Observations
* Embeddings
* Summaries
* Insights

Without modifying the evidence.

---

# UC-022 Query a participant's history

## Goal

View all of a participant's activity.

### Actor

User

### Result

A complete timeline of messages, events and participation in Cases.

---

# UC-023 Query statistics

## Goal

Get metrics about the conversation.

### Actor

User

### Examples

* Number of messages.
* Number of events.
* Open Cases.
* Pending reminders.
* Distribution by participant.

---

# UC-024 Export knowledge

## Goal

Export structured information.

### Actor

User

### Future formats

* JSON
* Markdown
* PDF

---

# UC-025 Audit the system

## Goal

Query the processing history.

### Actor

User

### Includes

* Imports.
* Reprocessing.
* Analysis versions.
* Models used.

---

# Priorities

## MVP

* UC-001
* UC-002
* UC-003
* UC-004
* UC-006
* UC-007
* UC-008
* UC-011
* UC-012
* UC-013
* UC-014

---

## Second version

* UC-009
* UC-010
* UC-015
* UC-016
* UC-017
* UC-018
* UC-019

---

## Future versions

* UC-020
* UC-021
* UC-022
* UC-023
* UC-024
* UC-025

---

# Goal

All use cases must preserve the evidence, enrich the system's knowledge and
provide verifiable answers backed by the original conversation.
