# AI providers

This product never depends on one vendor. Everything above `packages/ai` talks
to an `AiProvider` — five adapters implement it, and swapping between them is an
environment variable, not a code change.

Run `pnpm ai:doctor` after changing any of this. It takes about thirty seconds
and tells you exactly what is wrong, by name.

---

## Choosing a provider

```bash
AI_PROVIDER=claude-cli          # global default
AI_PROVIDER_INTERVIEW=claude-cli   # the guided life-story interview
AI_PROVIDER_VISION=openai-api      # photo analysis
AI_PROVIDER_EDL=claude-cli         # slideshow ordering
AI_PROVIDER_CAPTION=claude-cli     # captions and drafted copy
```

Precedence is: per-task override → `AI_PROVIDER` → `mock`.

Callers name the _work_ (`resolveProvider('photo-analysis')`); the env var keeps
the short name (`AI_PROVIDER_VISION`). The mapping is:

| Task in code     | Environment variable    |
| ---------------- | ----------------------- |
| `interview`      | `AI_PROVIDER_INTERVIEW` |
| `photo-analysis` | `AI_PROVIDER_VISION`    |
| `edl-generation` | `AI_PROVIDER_EDL`       |
| `copy-drafting`  | `AI_PROVIDER_CAPTION`   |

**In `NODE_ENV=test` the mock is forced**, whatever your shell says, and the
ignored variables are named in a warning. A test run must never reach a network
or spend a subscription.

Capabilities are checked when a provider is resolved, not when it is called. Ask
a text-only provider to look at photographs and you get a message at boot naming
the variable to change — not a failure halfway through somebody's evening.

---

## `mock` — the default, and what CI runs

Deterministic, offline, free. Answers come from `fixtures/ai/<task>/`; when no
fixture matches it synthesises the emptiest object the schema will accept. See
`fixtures/ai/README.md` for the file format.

```bash
AI_PROVIDER=mock
AI_FIXTURES_DIR=./fixtures/ai      # optional
```

---

## `claude-cli` — your Claude Code subscription

Spends a flat-rate subscription rather than per-token billing, which is what
makes developing a long guided interview affordable. Runs with
`--allowedTools Read` and nothing else: it is a capable agent and we are handing
it a family's photographs.

**Setup**

1. Install Claude Code: <https://claude.com/claude-code>
2. Run `claude` once and sign in.
3. `AI_PROVIDER=claude-cli`

**Variables**

| Variable              | Default   | Notes                                                         |
| --------------------- | --------- | ------------------------------------------------------------- |
| `CLAUDE_CLI_PATH`     | `claude`  | Full path, if it is not on `PATH`.                            |
| `AI_MODEL_CLAUDE_CLI` | CLI's own | Passed through as `--model`.                                  |
| `AI_CLI_TIMEOUT_MS`   | `120000`  | Shared with `codex-cli`. A hung CLI must not hang the worker. |

**Capabilities** — vision (file paths), native sessions, no native JSON schema
(the schema goes in the prompt), cost tier `subscription`.

Calls are serialised through a module-level mutex: one conversation at a time.

---

## `codex-cli` — your Codex subscription

Runs `codex exec --json --sandbox read-only`, resumes with
`codex exec resume <id>`, and parses the JSONL event stream.

Image support has moved between Codex releases, so it is **probed once** from
`codex exec --help` rather than assumed. If the probe says no, `vision` is
`false` and pointing `AI_PROVIDER_VISION` at it fails immediately with a message
naming the variable — which is far better than discovering it mid-batch.

**Setup**

1. Install the Codex CLI and run `codex login`.
2. `AI_PROVIDER=codex-cli`

**Variables**

| Variable            | Default   | Notes                                              |
| ------------------- | --------- | -------------------------------------------------- |
| `CODEX_CLI_PATH`    | `codex`   | Full path, if it is not on `PATH`.                 |
| `AI_CODEX_VISION`   | _(probe)_ | `1` or `0` to state the answer instead of probing. |
| `AI_CLI_TIMEOUT_MS` | `120000`  | Shared with `claude-cli`.                          |

**Capabilities** — vision _if probed true_ (file paths, via `-i`), native
sessions, no native JSON schema, cost tier `subscription`.

---

## `anthropic-api` — a key, billed per token

Plain `fetch` against `POST /v1/messages`; no SDK. Structured output uses forced
tool use — one tool called `emit` whose input schema is the schema we want back
— which is why this adapter declares `nativeJsonSchema: true`.

| Variable             | Default                     |
| -------------------- | --------------------------- |
| `ANTHROPIC_API_KEY`  | _(required)_                |
| `AI_MODEL_ANTHROPIC` | `claude-opus-5`             |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` |
| `AI_HTTP_TIMEOUT_MS` | `120000`                    |

**Capabilities** — vision (base64), no sessions, native JSON schema, cost tier
`metered`.

---

## `openai-api` — OpenAI, or anything that speaks its shape

`POST {OPENAI_BASE_URL}/v1/chat/completions`. Because the base URL is honoured,
the same adapter reaches OpenAI, Ollama, vLLM or LM Studio. A family that wants
nothing leaving their laptop points this at localhost and the rest of the
product is unchanged.

| Variable             | Default                  | Notes                                                                               |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | _(required unless…)_     | …a custom `OPENAI_BASE_URL` is set, which most local servers need no key for.       |
| `OPENAI_BASE_URL`    | `https://api.openai.com` | e.g. `http://localhost:11434` for Ollama.                                           |
| `AI_MODEL_OPENAI`    | `gpt-5`                  |                                                                                     |
| `OPENAI_JSON_SCHEMA` | off                      | `1` to use `response_format: json_schema`. Opt-in, because compatible servers vary. |
| `AI_HTTP_TIMEOUT_MS` | `120000`                 |                                                                                     |

**Capabilities** — vision (data URLs), no sessions, native JSON schema only when
`OPENAI_JSON_SCHEMA=1`, cost tier `metered`.

---

## Consent, and what leaves the machine

Photo analysis is gated per memorial. A **metered** provider means the pictures
go to a paid API, so the batch job refuses unless
`memorials.ai_consent_photo_analysis` is set — and it records the run as
_skipped_, not failed. Subscription CLIs and the mock are allowed by default,
because they are the family's own account or this machine.

Nothing enqueues photo analysis automatically. It happens when an organizer
presses **Look through the photographs** on the story page. What travels is the
downsized, EXIF-stripped `web1600` variant, never the original.

---

## Structured output

`generateObject(provider, zodSchema, { messages, taskTag })` is how every caller
asks for an object:

1. Native JSON Schema when the provider has it; otherwise the schema is appended
   to the last user message.
2. Parse: strip code fences → balanced first-brace-to-last-brace salvage →
   `JSON.parse` → `schema.safeParse`.
3. On failure, resend with a summary of the validation problems and the
   offending output. Two repairs, then a typed `AiSchemaError` carrying every
   attempt.

Callers show `friendlyAiMessage(error)` — one calm sentence that always ends in
"nothing you wrote was lost" — and log the detail. A family never sees a stack
trace.

---

## Testing against real adapters

CI runs the shared contract suite against the mock only. To run the same suite
against your own subscription:

```bash
AI_LIVE_TEST=1 pnpm vitest run --project ai
AI_LIVE_TEST=1 AI_LIVE_TEST_PROVIDERS=claude-cli pnpm vitest run --project ai
```

Adapters that are not installed or not keyed are skipped by name rather than
failing, so this is safe to type on any machine.

---

## `pnpm ai:doctor`

```
$ pnpm ai:doctor

claude-cli  (chosen by AI_PROVIDER)
  ✅  available       ready
  ✅  text            ready                                        6.4s
  ✅  generateObject  ok in 1 attempt                               5.1s
  ✅  vision          Red placeholder graphic labeled "Portrait…"   8.0s
  ✅  session resume  resumed 52d2010d…                            11.0s

codex-cli  (chosen by AI_PROVIDER_VISION)
  ❌  available       the "codex" command is not on PATH. Install the Codex CLI
                      and run `codex login` once, or set CODEX_CLI_PATH to its
                      full path.
  ·  text            skipped — provider is not available
  ·  generateObject  skipped — provider is not available
  ·  vision          skipped — provider is not available
  ·  session resume  skipped — provider is not available

1 provider needs attention: codex-cli
```

Exit code 1 if anything failed. Pass task names to narrow it:
`pnpm ai:doctor interview photo-analysis`.
