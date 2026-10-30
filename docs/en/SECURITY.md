# SECURITY.md

[Español](../SECURITY.md) · **English**

# WhatsApp Memory Search

## Purpose

This document defines the security principles and mechanisms of the system.

The goal is to protect the evidence, the derived knowledge and the user's
privacy without compromising traceability or auditability.

---

# Principles

## SEC-001

The conversation belongs exclusively to the user.

---

## SEC-002

Evidence takes priority over convenience.

It must never be modified to solve a security problem.

---

## SEC-003

Every access must be explicit.

---

## SEC-004

The principle of least privilege applies to all components.

Each module can only access the information it needs.

---

## SEC-005

Every relevant operation must be audited.

---

## SEC-006

Security must be designed into the architecture, not added afterwards.

---

# Evidence Protection

Evidence is the system's most important asset.

It includes:

* Conversation
* Participant
* Message
* Attachment

Evidence must be:

* persistent
* immutable
* verifiable
* auditable

It can never be modified by automated processes.

---

# Knowledge Protection

Derived artifacts include:

* Analysis
* Observation
* Insight
* Summary
* Embedding

These elements can be regenerated.

They are not the source of truth.

---

# Access Control

## User

Can:

* import conversations
* run queries
* create reminders
* request drafts
* start reprocessing

---

## System

Can:

* run pipelines
* generate knowledge
* update indexes
* regenerate derived artifacts

It can never modify evidence.

---

# Isolation Between Modules

Each Bounded Context must limit access to its own data.

Example

```text
Archive

↓

Knowledge

↓

Search

↓

Assistant
```

A context must never write directly into another.

Communication must go through defined interfaces.

---

# Encryption

Persistent information must be stored using the encryption mechanisms
provided by the infrastructure.

Special protection is recommended for:

* attachments
* backups
* secrets
* credentials

---

# Secrets Management

Credentials must never be stored in:

* source code
* repositories
* versioned configuration files
* prompts

They must be managed through a secure secrets system or environment
variables.

---

# Sensitive Information

The system may contain private information.

Examples

* names
* phone numbers
* addresses
* email addresses
* personal conversations
* photographs
* documents

All sensitive information must be treated as confidential.

---

# Auditing

Every relevant operation must record:

* date
* user or process
* operation
* affected resource
* result

Auditing must never modify the evidence.

---

# Versioning

Every regeneration of knowledge must keep:

* the model used
* version
* prompt
* date
* configuration

This makes it possible to reconstruct any result produced by the system.

---

# Integrity

The system must be able to verify that:

* messages were not altered
* attachments keep their reference
* relationships remain consistent

When possible, integrity checks such as hashes are recommended for the
evidence and for attachments.

---

# Availability

Temporary unavailability of the system must never cause loss of evidence.

Pending processes can be resumed later.

---

# Backup

There must be a backup strategy for:

* the database
* attachments
* configuration

Backups must allow the conversation to be fully restored.

---

# Event Logging

Recording security events such as the following is recommended:

* authentication errors
* denied accesses
* configuration changes
* massive reprocessing
* critical failures

---

# Protection Against AI

AI models must never:

* modify evidence
* delete information
* overwrite historical knowledge
* run actions without the user's authorization

AI only proposes.

The system decides.

---

# Input Validation

Every external input must be validated before it is processed.

Examples

* files
* messages
* queries
* parameters
* configurations

Validation must happen before persistence or processing.

---

# External Dependencies

External services must be considered untrusted.

Every response coming from an external provider must be validated before it
is incorporated into the system.

---

# Privacy

The system is designed for a single owner of the conversation.

It does not support multi-user access or sharing of conversations.

The user's privacy takes priority over any optimization.

---

# Restrictions

Never log secrets.

Never store credentials in plain text.

Never modify evidence to fix errors.

Never trust external data without validation.

Never allow an AI model to run irreversible actions.

Never delete audit records.

---

# Goal

To guarantee the confidentiality, integrity and availability of the
conversation and of the derived knowledge, always preserving the evidence as
the single source of truth and ensuring that every action performed by the
system is verifiable, auditable and reversible when appropriate.
