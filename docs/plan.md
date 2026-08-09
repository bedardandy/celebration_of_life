# Celebration of Life Media Toolkit — Implementation Plan

## Context

Greenfield repo (LICENSE only). We're building a toolkit that helps grieving families create the
media for a funeral/celebration of life — a coherent life story, a music-backed tribute
slideshow/video, and later eulogies and service coordination — while taking pressure off people
who are grieving, vary in tech aptitude, and have media scattered everywhere. Two research passes
(domain/human + technical) informed this design; the market gap is clear: **nobody owns the
direct-to-family, grief-sensitive, collaborative, end-to-end ceremony-media workspace** (Tukios
owns funeral homes, Tribute.co group video gifts, Empathy admin, Canva templates).

### Decisions made with the user
- **Web app**, guided and link-based; **families directly** (one organizer + contributor relatives
  via links — no accounts/apps for contributors).
- **MVP:** Story + slideshow end-to-end: guided life-story interview → photo collection/curation →
  music-backed tribute video MP4.
- **AI runtime: vendor-agnostic.** Provider abstraction; dev/testing driven by the user's Claude
  Code subscription (`claude -p`) and Codex subscription (`codex exec`) via CLI adapters, plus
  Anthropic/OpenAI-compatible API adapters and a deterministic mock for CI.
- **Execution:** implementation delegated to **Opus 5 coding subagents**, phase by phase, on
  branch `claude/celebration-life-media-toolkit-of6mx0`.

## Research foundations (what the product must honor)

**Human/domain:**
- Wolfelt's "7 elements of a meaningful funeral" (music, readings, viewing, eulogy, symbols,
  gathering, actions) = the product's information architecture; personalization + participation heal.
- Concrete defaults: ~5-min tribute video (3–8), 60–80 photos at 3–7s; **two cuts** (service +
  longer family version) as a first-class feature; eulogy 5–10 min.
- **"Grief brain"** (measurably impaired memory/attention/decisions; organizers often 55–80; 3–7
  day deadline, 24h for Jewish/Muslim): one decision per screen, aggressive autosave + magic-link
  resume, everything undoable, plain brief language, no blank pages, ≥48px targets, button
  alternatives to drag, nothing auto-plays, zero upsell/gamification.
- **Delegation is the core mechanic:** organizer + contributor links with tiny bounded asks
  ("share 5–10 photos by Wednesday", "answer one memory prompt").
- **Faith/timeline awareness** as data-driven *tradition packs* (Catholic: slideshow at
  vigil/reception not Mass; Jewish/Muslim: 24h burial → media targets shiva/gatherings;
  Hindu/Buddhist: 13-day/49-day cycles; secular: delayed celebrations). No `if (jewish)` in code.
- **AI = drafting partner, family = storyteller.** Interview-style capture beats forms; AI
  proposes, family approves; never auto-publish AI text.

**Technical:**
- **Remotion** renders the video; the same React composition is the live browser preview
  (`@remotion/player`) — preview and file are frame-identical. **ffmpeg** handles audio
  (fade/loudnorm/mux) and verification (ffprobe).
- **Music legal constraint:** commercial songs baked into video = per-song sync license =
  infeasible. Two modes: *cleared audio baked in* (bundled PD/royalty-free library → shareable) and
  *"silent + side-loaded"* (video timed to the family's song, not embedded; venue plays it live).
- Delivery of record: 1080p30 H.264/AAC yuv420p faststart MP4 (+720p backup), FAT32 USB guidance,
  printable funeral-director card. "It wouldn't play at the funeral" is the catastrophic failure.
- AI orchestration is a **workflow state machine** (collect → interview → curate → sequence →
  score → render → deliver); durable structured **LifeStoryDocument** (not transcripts) enables
  multi-session interviews; photo analysis → structured records → one EDL-generation call; exact
  timing math stays in code (beat-grid snapping), AI only proposes ordering/grouping/captions.

## Architecture

**Monorepo:** pnpm workspaces + Turborepo, TypeScript strict, Node 22. Dev = `pnpm install &&
pnpm dev` (web + worker); **ffmpeg on PATH is the single system prerequisite** (checked at boot
with friendly error; not yet installed in this environment — install via apt in Phase 0 setup).

```
apps/web         Next.js 15 App Router — organizer UI (m/[memorialId]/…), contributor pages
                 (c/[token]), magic-link auth (auth/[token]), api/ (uploads, auth-gated assets)
apps/worker      single Node process polling a DB-backed job queue (ingest, analyze, EDL, render, purge)
packages/schemas zod v4 single source of truth: EDL, LifeStoryDocument, TraditionPack, PhotoAnalysis,
                 job payloads (z.toJSONSchema() feeds AI structured output)
packages/db      Drizzle + SQLite (better-sqlite3), Postgres-ready conventions (text UUIDv7 PKs,
                 epoch-ms ints, JSON as validated text); includes jobs queue table
packages/core    domain logic: interview engine, EDL/timing engine, curation scoring, delegation
                 composer, token/auth logic
packages/ai      provider abstraction + adapters: mock | claude-cli | codex-cli | anthropic-api | openai-api
packages/media   sharp (HEIC/EXIF/variants), sharp-phash dedupe, blur scoring, ffmpeg audio wrappers,
                 beat-grid module (precomputed grids for bundled tracks; music-tempo fallback)
packages/storage BlobStore interface: LocalDiskStore (dev) | S3Store (presigned, later)
packages/video   Remotion project: TributeComposition + slide templates + Player wrapper
packages/tradition-packs  loader + zod validation; data/*.json (catholic, protestant, jewish, muslim,
                 hindu, buddhist, secular, unsure — each: pacing preset, media placement guidance,
                 music guidance, interview adjustments, delivery notes)
content/music-library     bundled cleared tracks + per-track meta.json (license provenance, beat grid)
fixtures/        test photos (HEIC/rotated/blurry/dupes), canned AI responses for mock provider
```

**Stack:** SQLite via Drizzle (no Redis/Docker; DB-backed job queue with lease/backoff), Uppy
uploads (HEIC ok, converted server-side), magic-link-only auth (organizer email links; contributor
capability URLs, hashed tokens, scoped + revocable), Vitest + Playwright + ffprobe-asserted
micro-renders.

### Data model (key tables)
`memorials` (traditionSlug, serviceDate, aiConsent flags, status checklist) · `people` ·
`participants` (organizer/contributor) · `magic_tokens` (hashed, kind, scopes, revocable) ·
`media_assets` (blobKey, phash, qualityScore, dupeGroupId, analysis JSON, curationState, caption)
+ `asset_variants` (thumb320/web1600/render2400) · `memory_notes` · `life_story_docs` (append-only
versioned LifeStoryDocument JSON) · `interview_sessions`/`interview_turns` · `slideshow_projects`
(EDL JSON, audioMode, cuts) · `music_tracks`/`music_selections` (licenseKind, beatGrid) ·
`render_jobs` (preset, progress, ffprobeMeta) · `jobs` (generic queue).

### AI provider abstraction (`packages/ai`)
- `AiProvider.complete(messages, {sessionId?, jsonSchema?})` + `AiCapabilities` flags
  (`nativeJsonSchema`, `vision`, `visionInput: 'file-path'|'base64'|'none'`, `nativeSessions`,
  `maxImagesPerCall`, `costTier`).
- `generateObject(provider, zodSchema)` sits above adapters: native JSON-schema when supported,
  else schema-in-prompt; JSON salvage → `safeParse` → repair-retry (max 2) → typed `AiSchemaError`.
- Adapters: **mock** (deterministic fixtures, CI default) · **claude-cli** (`claude -p
  --output-format json --resume`, vision via file paths, `--allowedTools Read` only, single-flight
  mutex) · **codex-cli** (`codex exec --json --sandbox read-only`, vision probed at startup) ·
  **anthropic-api** · **openai-api** (`OPENAI_BASE_URL` honored → covers Ollama/vLLM too).
- `resolveProvider(task)` with env config: `AI_PROVIDER` global + per-task overrides
  (`AI_PROVIDER_VISION`, `AI_PROVIDER_INTERVIEW`, …); capability mismatch fails fast at boot.
- Interview durable state = LifeStoryDocument + last-N turns (provider sessions are an
  optimization, never a requirement — that's what keeps it vendor-agnostic).

### Guided UX (grief rules enforced by a shared `StepScreen` layout)
Organizer: landing → intake wizard (relationship, tradition, service date → pacing preset) →
dashboard ("What would help right now?" — 3 cards + deadline-aware banner) → collect photos
(share link + QR + delegation composer with bounded-ask templates) → interview (one question at a
time, Skip / I'm done for now, "story so far" sidebar) → curate (era-grouped grid, tap-approve,
dupe groups collapsed, blurry flagged not removed, coverage nudges → delegation) → story shape
(one decision: recommended arc + why) → music (mode decision with plain-language licensing
explanation, then track picker filtered by tradition guidance) → preview (@remotion/player +
per-slide button-based adjustments) → deliver (cuts, render progress, MP4 downloads, USB/FAT32 +
director card + tradition placement note).
Contributor (capability URL, no account): bounded ask → first name → big upload button → optional
per-photo note + one memory prompt → "this link keeps working."

### Slideshow pipeline
EDL zod schema (chapters, slides: title/photo/quote/closing; Ken Burns from/to rects; transitions;
audio mode; cuts) → pure timing engine (3–7s band, snap transitions to beat-grid phrase
boundaries, fit to target, service-cut projection drops lowest-suitability slides) → Remotion
render (deterministic, frame == preview) → ffmpeg audio (trim/afade/loudnorm −16 LUFS/mux
faststart; sideloaded mode = silent AAC track + printable venue timing card) → ffprobe
verification. Presets: draft360 (fast check), final1080, backup720.

## Implementation phases (each = mergeable increment with acceptance criteria; executed by Opus 5 subagents)

- **Phase 0 — Scaffold** *(1 agent)*: monorepo, all schemas + Drizzle migrations, no-op worker
  queue, 3 starter tradition packs, CI (lint/typecheck/vitest), ffmpeg check.
  AC: `pnpm dev` boots web+worker; `pnpm test` green; test job completes; schemas round-trip fixtures.
- **Phase 1 — Memorial + auth spine** *(1 agent)*: create flow, intake wizard, magic-link login
  (console transport), dashboard shell, StepScreen + autosave pattern, soft-delete+undo.
  AC: create → magic link → dashboard; kill tab mid-wizard, nothing lost; link resumes.
- **Phase 2 — Photo collection & processing** *(1–2 agents, ∥ with 3)*: contributor links + QR +
  upload page, ingest job (HEIC→JPEG, EXIF, variants, phash dedupe, blur score), auth-gated asset
  serving, curation grid, delegation composer, memory notes.
  AC: fixture set processes correctly (dupes grouped, blurry flagged); asset URL 403s without
  token/session; contributor page works logged-out.
- **Phase 3 — AI package + interview** *(1–2 agents, ∥ with 2; depends only on 0)*: full
  `packages/ai` (5 adapters, generateObject + repair loop, resolveProvider, `pnpm ai:doctor`),
  interview engine + UI, LifeStoryDocument versioning + anecdote approval, photo-analysis batch job.
  AC (mock): 10-turn fixture interview → schema-valid LifeStoryDocument; repair-loop test passes;
  capability mismatch fails at boot. Live: user runs `pnpm ai:doctor` against claude/codex CLIs.
- **Phase 4 — EDL + Remotion + preview** *(1–2 agents, largely ∥ against fixtures)*: compositions +
  templates, timing engine, EDL generation, story-shape screen, Player preview + per-slide adjust,
  two-cut projection.
  AC: timing-engine unit tests; CI micro-render (320×180, 3 slides) passes ffprobe assertions;
  slide edits reflect in Player.
- **Phase 5 — Music + render + deliver** *(1–2 agents)*: bundled cleared library (≥8 tracks +
  beat meta + license provenance), music screens, full render worker (both modes, both cuts, 3
  presets, progress), delivery page (downloads, USB/director card, tradition placement note,
  sideloaded timing card).
  AC: CI render → ffprobe H.264/yuv420p/AAC/faststart, duration ±0.5s, loudness −16±1.5 LUFS;
  sideloaded output has silent AAC stream. **→ MVP complete.**
- **Phase 6 — Grief-UX hardening + hosted playback**: copy pass, voice input, watch/[token] page +
  live venue playback mode, email adapter, Postgres/S3 activation docs, full Playwright happy path.
- **Phase 7 — Deferred heavy media** (out of MVP): local face clustering (InsightFace/ONNX),
  opt-in restoration (Real-ESRGAN/CodeFormer with before/after consent), Google Photos Picker,
  eulogy studio, printed program.

**Execution approach:** phases run as Opus 5 coding subagents on the designated branch, committed
and pushed per phase (`git push -u origin claude/celebration-life-media-toolkit-of6mx0`). Phases
2+3 in parallel; 4 mostly parallel against fixtures. Each subagent gets its phase spec + AC +
the shared schema contracts; the main session reviews, integrates, and runs verification between
phases.

## Verification

- CI never touches a real model/network: `AI_PROVIDER=mock` enforced in test env; fixtures include
  a malformed-JSON case (repair loop) and an unfixable case (error UX).
- Unit: timing engine, cut projection, phash thresholds, token scoping, tradition-pack validation
  (every pack must parse), JSON salvage.
- Render smoke: tiny Remotion render + ffprobe assertions each CI run; full-quality render tested
  locally.
- Adapter contract suite runs against mock in CI and real CLIs via env-gated `pnpm test:live`;
  `pnpm ai:doctor` = 30-second live sanity check for the user's claude/codex subscriptions.
- End-to-end (post-Phase-5): create memorial → interview → upload fixtures → curate → pick music →
  preview → draft render → download; verified in-session with Playwright + ffprobe.

## Privacy posture

Private by default; every blob read auth-checked (no public URLs); tokens hashed, scoped,
revocable; **hard delete is real** (tombstone → purge rows + blobs + variants + renders; blob keys
prefixed `memorial/{id}/` for prefix purge); no third-party face APIs ever (face work stays
local); AI calls that leave the machine are consent-gated per memorial in plain language; photos
sent for analysis are downsized EXIF-stripped variants; no analytics in MVP; logs scrub PII.
