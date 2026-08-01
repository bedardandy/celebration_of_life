# Canned AI responses (mock provider)

CI never talks to a real model. `AI_PROVIDER=mock` is forced whenever
`NODE_ENV=test`, and the mock provider reads its answers from this directory.

## Layout

```
fixtures/ai/
  README.md
  <task>/                     interview | photo-analysis | edl | curation | caption
    <case>.json               one canned exchange
```

`<task>` is the `taskTag` the caller passed to `generateObject` (or
`complete`). It is never sent to a model.

## A case file

```jsonc
{
  "id": "05-garden",
  "task": "interview",

  // Optional. Case-insensitive substring of the request text (see "matching").
  "match": "the dahlias",
  // Or several alternatives:
  "matchAny": ["dahlia", "flower show"],

  // What the provider returns as AiCompleteResult.text.
  // A string is returned literally. An object is returned as pretty JSON —
  // which is how every structured fixture in here is written, because nobody
  // should be hand-escaping a page of JSON inside a JSON string.
  "response": { "nextQuestion": { "text": "…" } },

  // …or a scripted sequence. Successive calls that resolve to this case walk
  // the list and then stay on the last entry. This is how "returns broken JSON
  // once, then valid JSON" is expressed with no randomness anywhere.
  "responses": ["{ truncated…", { "nextQuestion": { "text": "…" } }],

  // Vision only: canned analysis per image file name.
  "images": { "04-garden.jpg": { "description": "…" } },

  "note": "Why this case exists.",
}
```

## Matching

The mock matches against **the last user message that is not a repair turn**,
with the appended JSON-Schema block stripped off — so a schema gaining a field
never invalidates a fixture, and a repair attempt resolves to the same case that
produced the broken output.

Resolution order, most specific first:

1. `<hash>.json`, where the file's `id` is the 12-character hash of the request
   text (`fixtureKey()`). For pinning one exact request.
2. The first case, in file-name order, whose `match` / `matchAny` appears in the
   request text. **Earlier files win**, so number them.
3. `default.json`.
4. No fixture: the mock synthesises the minimal object the request's JSON Schema
   will accept (empty strings, zeroes, first enum member). Obviously a
   placeholder, which is the point.

### Photo analysis is different

A batch job asks about N photographs and needs the answers tied back to N asset
ids that only exist at runtime, so a fixture cannot name them. Instead the job
writes `- <assetId> :: <path>` lines into the prompt, and the mock reads them
back and keys each canned analysis by the file's **basename**. Job and mock
share `parseAssetLines`, so the two cannot drift apart.

### EDL proposals and eulogy drafts are different too

Both of them have to name things that only exist once a real family has uploaded
and approved something, so both fixtures are written as **templates** and filled
from the prompt the job just built:

- `edl/` — `{{asset:N}}`, `{{memory:N}}`, `{{memoryFrom:N}}`
- `eulogy/` — `{{memory:N}}`, `{{memoryFrom:N}}`, `{{memoryId:N}}`

Placeholders with nothing to fill them are pruned rather than left dangling, so a
fixture written for four memories still works for a speaker who ticked two.

Quoted text in a eulogy fixture must always be a placeholder. A literal sentence
there would be words nobody said, standing in quotation marks, in a speech
somebody reads out at a funeral — which is the precise failure the verbatim
check exists to catch.

## Cases every phase must keep

These are load-bearing for the Phase 3 acceptance criteria:

- **`interview/10-recipe-box.json`** — scripted: broken JSON once, then the real
  turn. The ten-turn interview walkthrough goes through the repair loop because
  of this file.
- **`interview/90-unfixable.json`** — never becomes JSON. Exercises the typed
  `AiSchemaError` and the plain-language message a family sees instead of a
  stack trace.
- **`edl/malformed-json.json`** — valid JSON wrapped in prose and a code fence.
  Exercises salvage.
- **`edl/broken-once.json`** — the repair loop with a toy schema.
- **`edl/unfixable.json`** — the error path with a toy schema.

And for the eulogy studio:

- **`eulogy/00-misquote.json`** — a draft that puts quotation marks around a
  sentence nobody wrote, and claims a memory that was never chosen. Assembly
  must strip the quotation marks and drop the id. Do not "fix" the quote.
- **`eulogy/01-unfixable.json`** — never becomes JSON, so the studio has to show
  one calm sentence and keep the speech that is already written.

## Rules

- No real photos, no real names, no real story text. These files are committed;
  everything in them is invented. "Ruth" is nobody.
- Write them warm and specific anyway. A fixture that reads like lorem ipsum
  makes it very easy to ship an interview that reads like lorem ipsum too.
- No clock, no randomness, and no templating beyond the two placeholder sets
  above — which are deterministic substitutions from the request itself. A
  fixture that varies is a flaky test wearing a disguise.
