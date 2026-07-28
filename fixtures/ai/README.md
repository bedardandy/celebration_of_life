# Canned AI responses (mock provider)

CI never talks to a real model. `AI_PROVIDER=mock` is forced whenever
`NODE_ENV=test`, and the mock provider reads its answers from this directory.

Phase 0 ships the provider shell only: the mock echoes the last user message, so
this directory is currently empty apart from this file. Phase 3 adds the fixture
loader described below — the layout is written down now so tests written against
the mock keep working when it gains a memory.

## Layout

```
fixtures/ai/
  README.md
  <task>/                     interview | vision | edl | curation | caption
    <case>.json               one canned exchange
```

Each case file:

```jsonc
{
  "id": "interview-turn-03",
  "task": "interview",
  // Optional. When present, the mock only serves this case if the request
  // matches — substring match against the flattened last user message.
  "match": "tell me about the garden",
  // What the provider returns as `AiCompleteResult.text`.
  "response": "Which garden do you mean — the one behind the blue house?",
  // Optional metadata mirrored into AiCompleteResult.usage.
  "usage": { "inputTokens": 128, "outputTokens": 24 },
}
```

Ordering: cases are served in file-name order for a given task, so a numbered
sequence (`01-…`, `02-…`) drives a scripted multi-turn interview
deterministically.

## Cases every phase must keep

Two of these are load-bearing for the Phase 3 acceptance criteria, so please do
not delete them when tidying up:

- **`edl/malformed-json.json`** — a response with trailing commentary around the
  JSON. Exercises the salvage → `safeParse` → repair-retry loop.
- **`edl/unfixable.json`** — a response that never becomes valid JSON. Exercises
  the typed `AiSchemaError` and the plain-language error UX that a family would
  actually see.

## Rules

- No real photos, no real names, no real story text. These files are committed;
  everything in them is invented.
- Responses are literal strings. No templating, no clock, no randomness — a
  fixture that varies is a flaky test wearing a disguise.
- Keep them small. If a case needs 200 lines of JSON, the schema is the thing to
  reconsider.
