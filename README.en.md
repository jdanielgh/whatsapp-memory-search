# WhatsApp Memory Search

[Español](README.md) · **English**

> Archive a WhatsApp conversation as immutable evidence, index it, and ask
> questions about it — every answer cites the messages that support it.

An assistant that archives a WhatsApp conversation in PostgreSQL, processes
it with AI (entities, events, topics) and indexes it for literal and
semantic search. It answers natural-language questions **always citing the
messages that support the answer**, and says it cannot answer when the
evidence is not enough.

> **Documentation languages.** The main documentation is written in Spanish
> (`docs/`). This file and [`docs/en/`](docs/en/README.md) are the English
> complete English version of the design documents. Source-code comments are
> in Spanish.

## What sets it apart

- **The conversation is immutable evidence.** `conversations`,
  `participants`, `messages` and `attachments` are never modified: the
  Postgres role the app runs with does not even have `UPDATE`/`DELETE`
  permission on them. Everything else (entities, events, summaries,
  embeddings) is derived, regenerable knowledge.
- **Verifiable answers.** The model does not return free text but claims
  with the indexes of the evidence that backs them. A deterministic,
  system-side check marks as unsupported any claim that cites evidence that
  does not exist.
- **Idempotent, with spending under control.** Every stage can be re-run
  without repeating work (or paying for it twice). Runs that use real AI are
  opt-in, report their consumption and never run in tests or CI.
- **Decoupled AI.** The domain depends on an abstraction (`AIProvider`,
  `EmbeddingBatchProvider`), never on an SDK; tests use deterministic fakes.
- **Generic by design.** Topic categories, analysis dimensions and the
  prompt context come from a configurable **domain profile** (see below).

## How it works

```
WhatsApp export ──► Archive (immutable evidence)
                           │
        Metadata ─► Entities ─► Events + Cases ─► Embeddings
        (no AI)    (cheap AI)   (AI, by windows)   (pgvector)
                           │
   question ─► intent ─► search (literal / date / timeline /
                          topic / statistics / semantic)
                           │
                  answer + claims + cited evidence
```

[`docs/en/VISUAL_GUIDE.md`](docs/en/VISUAL_GUIDE.md) walks through the whole
system in diagrams: architecture, pipelines, the states of a message,
aggregates, how a question is answered and how an answer is checked against
the evidence. For product details see [`docs/en/VISION.md`](docs/en/VISION.md);
for technical decisions see [`docs/en/ARCHITECTURE.md`](docs/en/ARCHITECTURE.md).

## Stack

- Node.js / TypeScript (npm-workspaces monorepo)
- PostgreSQL + pgvector (evidence + semantic search, HNSW index)
- Drizzle ORM
- Swappable AI (see [`docs/en/AI_PROVIDERS.md`](docs/en/AI_PROVIDERS.md)):
  the Anthropic API or **Claude Code through a subscription** (no API
  balance) for classification and answers, and Voyage AI for embeddings
  (Anthropic does not expose an embeddings endpoint). Chosen by
  configuration.

## Quick start

Requires Node.js 20+ and Docker.

```bash
cp .env.example .env    # passwords; ANTHROPIC_API_KEY only if you use AI_PROVIDER=anthropic-api
npm install
npm run db:up           # starts Postgres + pgvector (docker compose)
npm run db:migrate      # applies the schema and the runtime role's permissions
npm run verify          # typecheck + unit + integration (does not use AI)
```

`npm run test:integration` runs against an ephemeral test database derived
automatically from the credentials in `.env`. `npm run verify` runs all
three layers and also runs in CI (`.github/workflows/verify.yml`).

### Usage

```bash
npm run sync -- --file ./_chat.txt --date-format dmy --timezone eu-cet-cest
npm run process:metadata
npm run process:entities -- --limit 100     # uses AI; bound it to validate
npm run process:events   -- --limit 100     # uses AI
npm run process:embeddings                  # uses Voyage
npm run ask -- "When was the schedule change agreed?"
```

| Command | What it does |
|---|---|
| `npm run sync` | Imports (first time) or syncs (afterwards) a WhatsApp export |
| `npm run process:metadata` | Language, emojis and mentions. Deterministic, no AI |
| `npm run process:entities` | Entity Detection. **Uses AI** |
| `npm run process:events` | Event Detection + Case Resolution. **Uses AI** |
| `npm run process:embeddings` | Embeddings for semantic search. **Uses Voyage** |
| `npm run ask -- "<question>"` | Answers with cited evidence. **Uses AI** |
| `npm run smoke:ai` | Manual smoke test against the configured engine, with made-up data |
| `npm run verify` | typecheck + unit + integration (never uses a real engine) |

Commands marked as using AI consume the resource of the configured engine
(API balance or subscription quota), print at the start which engine they
use and whether data leaves the machine, and report their consumption at
the end in the right unit. None of them prints message content, except
`ask`: there the evidence is the point, because an answer without the
messages that support it would not be verifiable.

## AI engines

The AI engine is chosen by configuration, without touching the code:

```bash
AI_PROVIDER=claude-code     # default: your Claude Code subscription (no API balance)
AI_PROVIDER=anthropic-api   # the Anthropic API (balance; requires ANTHROPIC_API_KEY)
```

`claude-code` requires Claude Code to be installed and signed in (if it is
missing, every command fails at startup with instructions, spending
nothing) and never uses your `ANTHROPIC_API_KEY`. You can also use a
different engine per tier (`AI_PROVIDER_CHEAP`, `AI_PROVIDER_DEFAULT`) and
choose the embeddings engine (`EMBEDDING_PROVIDER`). What each costs, where
the data goes and how to add your own engine:
[`docs/en/AI_PROVIDERS.md`](docs/en/AI_PROVIDERS.md).

## Domain profiles

What changes between one use and another (topic categories, analysis
dimensions, the context injected into the prompts, the time windows used to
group events into a topic) lives in a **domain profile**, not in the code.
Without configuration the bundled generic profile is used.

To use your own, copy [`profiles/example.json`](profiles/example.json) to
`profiles/local/` (ignored by git), adjust it and point to it:

```bash
DOMAIN_PROFILE_PATH=profiles/local/my-profile.json
```

An invalid profile aborts with a clear error; it never silently falls back
to the generic one. The active profile is recorded in the `prompt_version`
of every analysis, so you can tell which interpretation produced each one.

## AI cost

Two model tiers depending on the task (`tier: "cheap" | "default"`):

- **`cheap` (Haiku)**: high-volume, low-ambiguity structured extraction
  (Entity Detection).
- **`default` (Sonnet)**: classification where a mistake weighs more than
  the cost (Event Detection).

Chat messages are short, so the cost per call is dominated by the fixed
prompt. That is why both stages **group several messages per call**
(batches of 25 for entities, windows of 20 consecutive messages for
events). Orders of magnitude measured on a real corpus, per 1,000 messages:

| Stage | Model | Approx. cost |
|---|---|---|
| Entity Detection | Haiku 4.5 | ~$0.28 |
| Event Detection | Sonnet 5 | ~$0.65 |
| Embeddings | Voyage `voyage-3-large` | $0 within the free tier |

The costs in the table are for the Anthropic API. With `claude-code` there
is no per-token charge: consumption is subscription quota, which is shared
with your interactive use. Measured on one specific plan, processing a
corpus of thousands of messages took roughly one 5-hour session window (the
figure depends on your plan), at about 10 s per call.

Processing runs once over the backlog and then in small increments as you
sync. Each question to the assistant costs on the order of cents with the
API.

## Project status

- ✅ **01 Foundations**: scaffolding, schema, AI abstraction.
- ✅ **02 Archive & Ingestion**: import/sync a WhatsApp export.
- ✅ **03 Processing & Knowledge**: metadata, entities, events and Cases.
- ✅ **04 Search & Evidence**: literal, date, timeline, Case and statistics
  search.
- ✅ **05 Embeddings & Semantic Search**.
- ✅ **06 Agent & Q&A**: answers with evidence and deterministic validation
  of citations.
- ✅ **Domain profiles**.
- 🔄 **Swappable AI engines**: factory, Anthropic API and Claude Code through
  a subscription available; local models (`openai-compatible`) and local
  embeddings planned.
- ⏳ Insights, summaries, reminders, drafts, reprocessing and continuous
  ingestion through the Cloud API: planned.

## Data and privacy

A chat history can contain personal data of real third parties, minors included.
That is why the project never includes real conversations (fixtures are
made up), never prints the full history, and requires encrypting any backup
that leaves the local machine. See `.claude/rules/security-privacy.md` and
[`docs/en/SECURITY.md`](docs/en/SECURITY.md).

The project is developed with Claude Code; its configuration (rules, skills
and agents) lives in `.claude/`.

## License

[MIT](LICENSE) © 2026 Jesus Daniel Gomez Hernandez
