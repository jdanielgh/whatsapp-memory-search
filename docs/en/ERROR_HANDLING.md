# ERROR_HANDLING.md

[Español](../ERROR_HANDLING.md) · **English**

# Conversation Memory Assistant

## Purpose

This document defines the system's error-handling strategy.

Its goal is to ensure that failures never compromise the evidence, that
processes can recover safely and that all operations are auditable.

---

# Principles

## EH-001

Loss of evidence is unacceptable.

---

## EH-002

Every error must be recorded.

---

## EH-003

Errors must be recoverable whenever possible.

---

## EH-004

A failure in one pipeline must never affect other pipelines.

---

## EH-005

Every operation must be idempotent.

---

## EH-006

Automatic recovery takes priority over manual intervention.

---

# Error classification

## Validation Error

Occurs when the input does not meet the expected rules.

Examples

* Invalid file.
* Corrupt message.
* Invalid date.
* Unknown format.

### Action

* Reject the operation.
* Record an audit entry.
* Keep the evidence available.

---

## Persistence Error

Occurs when storing information.

Examples

* Database unavailable.
* Constraint violation.
* Timeout.

### Action

* Retry.
* Record the error.
* Do not continue the pipeline.

---

## Processing Error

Occurs during a pipeline.

Examples

* Entity Detection.
* Event Detection.
* Summary Generation.

### Action

* Stop only the affected stage.
* Record the state.
* Allow re-execution.

---

## AI Model Error

Examples

* Timeout.
* Rate limit.
* Invalid response.
* Incomplete output.

### Action

* Retry.
* Record the model used.
* Keep previous versions.

---

## Search Error

Examples

* Corrupt index.
* Missing embedding.
* Ranking error.

### Action

* Regenerate indexes when possible.
* Do not modify the evidence.

---

## Internal Error

Unexpected errors.

Examples

* Unhandled exceptions.
* Invalid configuration.
* Unavailable dependencies.

### Action

* Record enough information for diagnosis.
* Mark the operation as failed.
* Allow recovery.

---

# Recovery strategy

## Recovery by stage

Each pipeline stage can be run again independently.

It is never necessary to restart the whole processing.

---

## Recovery by artifact

The following artifacts can be deleted and regenerated:

* Analysis
* Observation
* Insight
* Summary
* Embedding

Never:

* Conversation
* Participant
* Message
* Attachment

---

## Recovery by batch

If an import partially fails:

* keep the evidence already persisted
* record progress
* continue from the last consistent point

---

# Retries

## Eligible operations

* Persistence
* AI
* Indexing
* External services

---

## Non-eligible operations

* Validation
* Domain integrity
* Business rule violations

---

## Policy

Each operation defines:

* maximum number of attempts
* wait strategy
* give-up condition

---

# Idempotency

All critical operations must be able to run multiple times without producing
inconsistent results.

Examples

* import messages
* generate embeddings
* detect entities
* detect events
* update indexes

---

# Error states

```text
PENDING

↓

RUNNING

↓

SUCCESS
```

or

```text
PENDING

↓

RUNNING

↓

FAILED

↓

RETRYING

↓

SUCCESS
```

or

```text
PENDING

↓

RUNNING

↓

FAILED

↓

MANUAL_REVIEW
```

---

# Recorded information

Every error must record at least:

* identifier
* date
* pipeline
* stage
* type
* severity
* message
* exception
* context
* operation
* duration
* system version
* model version (if applicable)

---

# Severity

## LOW

The system can continue with no functional impact.

Example

Temporary failure of summary generation.

---

## MEDIUM

A feature is affected, but automatic recovery exists.

Example

Failure generating embeddings.

---

## HIGH

An important pipeline is interrupted.

Example

Persistence unavailable.

---

## CRITICAL

Compromises the availability or integrity of the system.

Example

Database corruption.

---

# Reprocessing

AI-related errors never require modifying the evidence.

Recovery consists of regenerating:

* Analysis
* Observation
* Insight
* Summary
* Embedding

---

# Auditing

Every recovery must record:

* reason
* user or process
* date
* affected artifacts
* result

---

# Notification

The system may notify errors when:

* an import fails
* a reprocessing run fails repeatedly
* manual intervention is required

Recoverable internal errors do not require notifying the user.

---

# Restrictions

Never delete evidence to resolve an error.

Never overwrite historical analyses.

Never hide errors.

Never continue a pipeline when a mandatory precondition is not met.

Never answer the user using artifacts marked as invalid or incomplete.

---

# Goal

To ensure that all failures are detectable, auditable and recoverable,
always preserving the original evidence and ensuring that derived knowledge
can be regenerated without compromising the integrity of the system.
