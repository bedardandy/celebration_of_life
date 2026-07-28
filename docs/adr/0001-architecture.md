# ADR 0001 — Baseline architecture

- **Status:** accepted
- **Date:** 2026-07-28
- **Applies to:** Phase 0 scaffold and everything built on it

## Context

We are building a toolkit that helps a grieving family produce the media for a
funeral or celebration of life: a coherent life story, a music-backed tribute
video, and later eulogies and service coordination.

Three constraints shape every decision below.

1. **The people using it are grieving.** Measurably impaired memory and
   attention, often aged 55–80, working to a 3–7 day deadline (24 hours in some
   traditions), with photos scattered across phones, drawers and other people's
   houses. One decision per screen; nothing can be lost; nothing may require an
   account from a contributing relative.
2. **"It wouldn't play at the funeral" is the catastrophic failure.** The output
   file matters more than any feature.
3. **This is built by AI coding agents across parallel phases.** Contracts have
   to be explicit and machine-checkable, or the phases diverge.

## Decisions

### 1. pnpm + Turborepo monorepo, TypeScript strict, Node 22

One `pnpm install`, one type system, one test runner. Packages are published as
TypeScript **source** with no build step (`main: ./src/index.ts`); Next
transpiles what it imports. Phases can be developed in parallel against shared
types without waiting on build artefacts.

### 2. zod v4 in `@col/schemas` is the single source of truth

The EDL, LifeStoryDocument, TraditionPack, PhotoAnalysis and job payloads are
zod schemas first. Types are inferred from them, DB JSON columns are validated at
the boundary against them, and `z.toJSONSchema()` feeds AI structured output from
the same definition. One definition, three consumers, no drift.

### 3. SQLite via Drizzle, Postgres-portable by construction

No Redis, no Docker, no broker. A family's evening is not the place to debug
infrastructure and neither is a solo developer's laptop. The conventions —
text UUIDv7 primary keys, integer epoch-millisecond timestamps, JSON in text
columns — are chosen so the dialect can be swapped for Postgres later without a
data model rewrite.

### 4. The job queue is a table

`jobs` plus a transactional claim, a lease, and exponential backoff. A crashed
worker's job returns to the queue when its lease expires rather than sitting in
`running` forever. The whole queue is inspectable with `sqlite3 data/app.db`.

**Rejected:** BullMQ/Redis (an extra daemon for perhaps a hundred jobs a day),
in-process timers (loses work on restart).

### 5. Remotion renders the video; ffmpeg does the audio

The same React composition is both the live browser preview
(`@remotion/player`) and the rendered MP4, so preview and file are
frame-identical. ffmpeg handles trim/fade/loudnorm/mux, and **ffprobe verifies
the output** before anything is called finished. ffmpeg on PATH is the single
system prerequisite, checked at boot with an actionable message.

**Rejected:** ffmpeg-only slideshow assembly (no honest preview), a cloud video
API (private family photos leaving the machine, plus per-render cost).

### 6. Timing maths lives in code; AI only proposes

A pure timing engine computes durations, snaps transitions to musical phrase
boundaries, fits the target length and projects the shorter service cut. AI
proposes ordering, grouping and captions, and the family approves them. This is
what makes the output testable and the product trustworthy: nothing AI-authored
is ever published without an explicit approval.

### 7. AI is vendor-agnostic behind `@col/ai`

`AiProvider.complete()` plus declared `AiCapabilities`. Adapters: `mock`
(deterministic, CI default), `claude-cli`, `codex-cli`, `anthropic-api`,
`openai-api`. `resolveProvider(task)` reads `AI_PROVIDER` with per-task
overrides, and a capability mismatch fails at boot. Durable interview state is
the LifeStoryDocument, never a provider's conversation memory — provider
sessions are an optimisation, never a requirement.

### 8. Faith and culture are data, not branches

`@col/tradition-packs` loads validated JSON packs, each answering the same
questions: pacing preset, where media belongs, music guidance, interview
adjustments, delivery notes. The codebase contains no `if (tradition ===
'catholic')`. Adding a tradition is adding a file, and getting one wrong is a
content fix rather than a code change.

### 9. Music: two honest modes

Baking a commercial song into a shareable video requires a per-song
synchronisation licence we cannot obtain on a family's behalf. So: **cleared
audio baked in** (bundled public-domain/royalty-free library with committed
licence provenance) or **silent and side-loaded** (video timed to the family's
song, played live by the venue, with a printed timing card). The constraint is
explained to the family in plain language rather than hidden.

### 10. Private by default

No public blob URLs — every read is auth-checked. Magic links only: hashed,
scoped, revocable tokens; contributors never make an account. Blob keys are
prefixed `memorial/{id}/` so a hard delete is a real prefix purge, not a flag.
Photos sent for AI analysis are downsized, EXIF-stripped variants, and any call
leaving the machine is consent-gated per memorial. No third-party face APIs,
ever; no analytics in the MVP.

## Consequences

- ffmpeg must be installed. This is the one thing we ask of a developer, and the
  friendly install message lives in `@col/media`.
- Source-only workspace packages mean `transpilePackages` in `next.config.ts`
  must list every `@col/*` the web app imports.
- SQLite means a single writer. Fine for one worker process; the move to
  Postgres is a dialect swap, and the conventions above are what keep it cheap.
- Every phase inherits the same contracts, so parallel agents can build against
  the schemas without coordinating on anything else.
