# AI providers

[Español](../AI_PROVIDERS.md) · **English**

The domain never calls a model directly: it depends on two interfaces, and a
concrete **provider** is chosen by configuration. This guide explains which
engines exist, how to choose one and how to add another.

## Available engines

| Name | Registered as | Consumes | Data leaves the machine | Status |
|---|---|---|---|---|
| `anthropic-api` | completions | API balance (money) | yes | available (opt-in) |
| `claude-code` | completions | your Claude Code subscription quota | yes | available, **default** |
| `voyage` | embeddings | Voyage free quota; money if exceeded | yes | available, **current default** |
| `openai-compatible` | completions | depends (local: machine time) | no if local | planned |
| local embeddings | embeddings | machine time | no | planned |

What each stage does with AI: **completions** runs Entity Detection, Event
Detection, Intent Detection and answer generation; **embeddings** feeds the
semantic search.

## Choosing the engine

Everything is configured with environment variables (read only in
`packages/core/src/shared/config.ts`):

| Variable | What it does | Default |
|---|---|---|
| `AI_PROVIDER` | completions engine | `claude-code` |
| `AI_PROVIDER_CHEAP` / `AI_PROVIDER_DEFAULT` | a different engine for one tier | the one in `AI_PROVIDER` |
| `EMBEDDING_PROVIDER` | embeddings engine | `voyage` |

An unknown name fails at startup and lists the available ones. The two tiers
are `cheap` (high-volume extraction, e.g. entities) and `default`
(interpretation where a mistake weighs more, e.g. events). With a different
engine per tier, a `RoutingProvider` delegates according to the tier without
the use cases noticing.

```bash
# Only the Claude Code subscription, no API balance
AI_PROVIDER=claude-code

# Mixed: one engine for each tier
AI_PROVIDER_CHEAP=anthropic-api
AI_PROVIDER_DEFAULT=claude-code
```

Every run prints to `stderr` which engine it uses, what it consumes and
whether data leaves the machine, and records that in `system_audit_log`
together with the domain profile:

```
IA: claude-code · consume: cuota de suscripción · datos salen del equipo: sí · esquema forzado por el motor
```

(The run header is printed in Spanish.)

Choosing an engine means choosing where the data goes
(`.claude/rules/security-privacy.md`, rule 8) and which resource is spent
(`.claude/rules/ai-cost.md`).

## `anthropic-api`

Uses the official SDK with `ANTHROPIC_API_KEY`. Structured output is forced
with tool use. The models for each tier come from `AI_MODEL_CHEAP` and
`AI_MODEL_DEFAULT`. It is the only engine converted to USD in the
consumption report.

## `claude-code` (subscription)

Runs Claude Code in non-interactive mode (`claude -p`) and therefore spends
your subscription quota, not API balance.

**Requirements:** Claude Code installed and signed in (`claude login`).
Because it is the default engine, every CLI checks it at startup with
`claude auth status`, which does not consume quota: if there is no session,
or `claude` is authenticated with an API key (it would spend balance), it
fails **before** the first call with a message that says how to fix it or how
to switch to `AI_PROVIDER=anthropic-api`.

| Variable | What it does | Default |
|---|---|---|
| `CLAUDE_CODE_MODEL_CHEAP` | model for the `cheap` tier | `haiku` |
| `CLAUDE_CODE_MODEL_DEFAULT` | model for the `default` tier | `sonnet` |
| `CLAUDE_CLI_PATH` | path to `claude.exe` if it is not on the `PATH` | found automatically |
| `CLAUDE_CODE_TIMEOUT_MS` | maximum time per call | `300000` |

Good to know:

- **It does not use your `ANTHROPIC_API_KEY`.** The provider removes it from
  the subprocess environment; otherwise `claude` would silently bill the API.
  A test checks this.
- **The `haiku`/`sonnet` aliases point to the latest model and change over
  time.** For reproducible results, pin an explicit model ID. The real model
  that served each call is the one that gets recorded.
- **The quota is shared with your interactive use.** A large run can leave
  you without it. Measure first with a bounded run (`--limit`) and compare
  `/usage` before and after. A reached limit stops the run with a clear
  error, and because processing is idempotent it resumes later without
  repeating work.
- **It is slower than the API:** about 10 s per call, sequentially (Event
  Detection needs to process windows in order). A corpus of thousands of
  messages takes on the order of two hours.
- **Reasoning:** `thinking: "disabled"` is translated into `--effort low`. In
  Haiku, reasoning cannot be removed entirely.
- **Responses that do not meet the schema** are returned as text and rejected
  by the parser per message; engine errors (no session, usage limit, process,
  timeout) are thrown and stop the run.
- **It does not generate embeddings.** Use `EMBEDDING_PROVIDER`.
- On Windows `claude` is a `claude.cmd` shortcut; the provider launches
  `claude.exe` directly.

## `voyage` (embeddings)

Uses the Voyage API with `VOYAGE_API_KEY`, `EMBEDDING_MODEL` and
`EMBEDDING_DIMENSIONS` (currently `voyage-3-large` at 1024). "Free" means
within the free quota: without a registered payment method the account is
limited to a few requests per minute, which makes a large corpus unviable.
Changing the embeddings model does not overwrite the previous vectors (they
coexist by `model` and `dims`); if the dimension changes, a migration is
needed.

## A provider's contract

A completions provider implements `DescribedAIProvider`
(`infrastructure/ai/provider.ts`):

```ts
interface DescribedAIProvider {
  readonly info: ProviderInfo;                       // name + capabilities
  complete(prompt: string, opts?: CompletionOptions): Promise<string>;
  embed(text: string, opts?: EmbeddingOptions): Promise<number[]>;
}
```

An embeddings provider implements `DescribedEmbeddingProvider` with
`embedBatch(texts, { model, dimensions, inputType })`.

**Declared capabilities** (`info.capabilities`):

| Field | Values | What for |
|---|---|---|
| `structuredOutput` | `native` / `prompt` | whether the engine forces the schema or the parser is relied on |
| `usage` | `exact` / `estimated` / `none` | whether it reports tokens |
| `billing` | `api` / `subscription` / `local` | which resource it consumes |
| `dataLeavesMachine` | `true` / `false` | where the data goes |
| `supportsThinking` | `true` / `false` | whether it honors `thinking` |

**The error boundary is the most important rule** and all engines share it:

- An **engine** failure (credential, no quota, network, process, timeout,
  usage limit) is **thrown**. It stops the run: if it were treated as a
  per-message failure, an engine without quota would generate thousands of
  silent failures.
- A **malformed** model response is **returned as text**. The parser rejects
  it per message (SI-034) and the message stays retryable.
- A response **cut off** by the token cap throws `ModelResponseTruncatedError`:
  it is told apart from a format error because the corrective action is
  different.

**Usage and cost:** if the engine reports tokens, it calls `opts.onUsage`
with the real model that served the call and `billing`. A failure in the
counter must never break a call that was already consumed. Only
`billing: "api"` is converted to USD.

## How to add a provider

1. **Write the class** in `packages/core/src/infrastructure/ai/`
   implementing `DescribedAIProvider` (or `DescribedEmbeddingProvider`) and
   declaring `info`. If it launches a process or makes HTTP calls, **inject**
   the launcher or `fetch` so it can be tested with a fake.

   ```ts
   export class MyProvider implements DescribedAIProvider {
     readonly info: ProviderInfo = {
       name: "my-provider",
       capabilities: {
         structuredOutput: "prompt",
         usage: "estimated",
         billing: "local",
         dataLeavesMachine: false,
         supportsThinking: false,
       },
     };
     async complete(prompt: string, opts: CompletionOptions = {}) { /* ... */ }
     async embed(): Promise<number[]> { throw new Error("not supported"); }
   }
   ```

2. **Register it** in `factory.ts`:

   ```ts
   aiProviderRegistry.register("my-provider", () => new MyProvider());
   ```

3. **Configuration**: new variables only in `shared/config.ts` (the only
   reader of `process.env`) and documented in `.env.example`. Model names are
   specific to each engine: do not reuse `AI_MODEL_*`, or two engines would
   live with the same name for different things.

4. **Tests** (without calling the real engine, `.claude/rules/ai-cost.md`
   rule 1). At a minimum:
   - it builds the invocation correctly (model by tier, schema only when
     requested);
   - it returns the response text, and a response that does not meet the
     schema is **returned** instead of throwing;
   - an engine failure **throws** with a message that says what to do;
   - truncation throws `ModelResponseTruncatedError`;
   - it reports the real model and `billing` in `onUsage`, and a failing
     `onUsage` does not break the call;
   - it does not leak credentials that would change the resource consumed;
   - it uses **real** fixtures captured with made-up text when they exist
     (`infrastructure/ai/fixtures/`), not hand-written envelopes.

   A contract suite shared across engines is planned; until then this list is
   the contract.

5. **Qualify it before using it seriously**: `npm run verify`, the smoke test
   (`AI_PROVIDER=my-provider npm run smoke:ai`, made-up messages) and a
   subset of the regression bank compared against the baseline, with
   thresholds fixed **before** running.

6. **Document it** in the table of this file and declare in `info` whether
   data leaves the machine.

## Common problems

| Symptom | Cause and fix |
|---|---|
| `Proveedor de completions desconocido: "x". Disponibles: …` (unknown completions provider) | `AI_PROVIDER` is misspelled; use one of the listed names |
| `Failed to authenticate` / a message mentioning `claude login` | the Claude Code session expired; sign in from a terminal |
| Subscription usage-limit error | wait for the quota to reset and re-run the same command; it resumes without repeating work |
| `No se pudo lanzar Claude Code` (could not launch Claude Code) | install Claude Code or set `CLAUDE_CLI_PATH` |
| The report says "sin costo en USD" (no USD cost) | that is correct with a subscription or local engine: it is reported in calls and tokens |
| `Claude Code no devolvió JSON` (did not return JSON) | the CLI failed to start; check the `stderr` that accompanies the message |

Runtime messages are printed in Spanish.
