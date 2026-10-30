# Documentation (English)

[Español](../README.md) · **English**

The primary documentation of this project is written in Spanish and lives in
[`docs/`](../README.md). This folder holds the complete **English version of
the design documents**.

## Start here

| Document | What it covers |
|---|---|
| [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md) | The whole system in diagrams: architecture, pipelines, message states, aggregates, how a question is answered and verified. |
| [`VISION.md`](VISION.md) | Product vision, goals and principles. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, principles and architecture decisions. |
| [`AI_PROVIDERS.md`](AI_PROVIDERS.md) | AI engines: which to use, what each one consumes, and how to add another. |
| [`SECURITY.md`](SECURITY.md) | Security principles and handling of personal data. |

## Domain and rules

| Document | What it covers |
|---|---|
| [`SYSTEM_INVARIANTS.md`](SYSTEM_INVARIANTS.md) | System invariants (`SI-…`). |
| [`USE_CASES.md`](USE_CASES.md) | Use cases (`UC-…`). |
| [`QUERY_CATALOG.md`](QUERY_CATALOG.md) | The catalogued queries (`Q-…`). |
| [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) | Domain entities and rules. |
| [`AGGREGATES.md`](AGGREGATES.md) | Aggregates and consistency boundaries (`AG-…`). |
| [`BOUNDED_CONTEXTS.md`](BOUNDED_CONTEXTS.md) | The single current context and the criteria for future ones. |
| [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) | Glossary and prohibited terms. |

## Data, processing and failures

| Document | What it covers |
|---|---|
| [`DATA_MODEL.md`](DATA_MODEL.md) | Physical schema (tables, types, indexes). |
| [`PIPELINES.md`](PIPELINES.md) | Processing pipelines and message states (`PL-…`). |
| [`ERROR_HANDLING.md`](ERROR_HANDLING.md) | Error handling strategy (`EH-…`). |

## Notes

- If a document and the code disagree, the code wins.
- Source-code comments are in Spanish.
- Some stored values (event types, entity types, analysis dimensions) are
  Spanish words; the English documents keep them verbatim and gloss them.
