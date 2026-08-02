# Celebration of Life

A gentle way to gather photos, memories, and music for a celebration of life.

This toolkit helps a grieving family create the media for a funeral or celebration of life:
a life story built through a warm, one-question-at-a-time interview; photos collected from
relatives through a simple link (no accounts, no apps); a music-backed tribute video rendered
as an MP4 that reliably plays on venue equipment; and the printable cards that make the day
go smoothly.

It is designed for the week nobody plans for. The people using it are grieving, often older,
often under a three-to-seven-day deadline (sometimes 24 hours), and their photos are scattered
across phones, cloud accounts, and shoeboxes. Every screen asks one question. Everything
autosaves. Everything can be undone. Nothing auto-plays, upsells, or rushes.

## What it does

- **Collect** — a per-memorial share link + QR code that relatives open on their phones to add
  photos (HEIC fine, old prints photographed fine) and answer one memory prompt. The organizer
  can send personal "bounded asks" ("could you add 5–10 photos of Ruth from her younger years
  by Wednesday?"). Uploads are deduplicated, quality-scored, rotated, and grouped by era.
- **Tell their story** — an unhurried interview builds a structured life story document,
  chapter by chapter. The AI proposes; the family approves every anecdote before it is used
  anywhere. Skipping a question is always allowed and never commented on.
- **Build the slideshow** — one AI call proposes ordering, chapters, and captions; everything
  else is deterministic code. Quote cards must be word-for-word copies of approved memories —
  a rewritten quote is dropped, never shown. The browser preview and the rendered file are the
  same React composition, frame for frame. Slide timing snaps to the music's phrase boundaries.
- **Music, legally** — two modes, explained in plain language: use the included cleared music
  (the video can be shared anywhere), or time the video to the family's own song, delivered
  silent, with a printable venue timing card — the song plays out loud at the service under the
  venue's own license. Eight original instrumental tracks ship with the product (CC0, generated,
  exact beat grids). Families can also upload a recording they own, or find their song by ear —
  a search box backed by Apple's free preview API plays a half-minute clip to confirm it's the
  right version before the details are filled in.
- **Deliver** — 1080p H.264/AAC faststart MP4 (plus 720p backup and a quick draft preset),
  loudness-normalized to −16 LUFS, ffprobe-verified before it is ever called done. Dignified
  filenames, USB/FAT32 instructions, and a printable funeral-director card ("please test it on
  the venue's own equipment before the service").
- **Share and hear back** — a private, revocable viewing link streams the draft to family
  anywhere; viewers can leave a note pinned to a moment in the video ("at 1:23 — that photo is
  upside down"), which lands on the organizer's gentle checklist with done/undo. A co-organizer
  invite link shares the whole workload with a sibling — no passwords anywhere, the link is the
  credential, and every link can be turned off.
- **Speeches & program** — a eulogy studio for each person speaking: a guided setup (who,
  how long, how it should sound, which memories), one AI call for a first draft built only
  from the memories that speaker ticked, versioned editing with "a little shorter / warmer /
  simpler words", a read-aloud timer that adds the 25% everyone loses to emotion on the day,
  large-print and graveside versions. Anything in quotation marks must be word-for-word what
  somebody actually wrote, or the quotation marks come off. Alongside it, a printable
  order-of-service program: cover, order (prefilled from the tradition pack), life sketch,
  a public-domain reading, and the thank you.
- **Faith-aware, data-driven** — tradition packs (Catholic, Protestant, Orthodox, Jewish,
  Muslim, Hindu, Buddhist, homegoing, secular) carry
  pacing, media-placement guidance ("slideshows belong at the vigil or reception, generally not
  the Mass"), and music guidance in their own words. There is no `if (catholic)` anywhere in the
  code; a new tradition is a JSON file, not a feature branch.

## AI: vendor-agnostic by design

All AI features go through one provider interface with schema-validated structured output and
a repair loop. Five interchangeable adapters:

| Provider        | How                                                                          | Env                                 |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| `mock`          | Deterministic fixtures — default in dev and the only provider tests may use  | `AI_PROVIDER=mock`                  |
| `claude-cli`    | Your Claude Code subscription via `claude -p` (text, JSON, vision, sessions) | `AI_PROVIDER=claude-cli`            |
| `codex-cli`     | Your Codex subscription via `codex exec` (vision probed at startup)          | `AI_PROVIDER=codex-cli`             |
| `anthropic-api` | Anthropic Messages API                                                       | `ANTHROPIC_API_KEY`                 |
| `openai-api`    | Any OpenAI-compatible endpoint — includes Ollama/vLLM/LM Studio              | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |

Providers can be mixed per task (`AI_PROVIDER_INTERVIEW`, `AI_PROVIDER_VISION`, ...). Run
`pnpm ai:doctor` for a 30-second check of whatever you have configured. Details in
[docs/ai-providers.md](docs/ai-providers.md).

Photos sent for analysis are downsized, EXIF-stripped variants, and cloud analysis is gated on
explicit per-memorial consent. Face recognition is never sent to third-party services.

## Running it

Prerequisites: Node 22, pnpm 10, ffmpeg on PATH.

```bash
pnpm install
pnpm dev          # web app on :3000 + background worker
```

Open http://localhost:3000, create a memorial, and walk through it. In development the magic
link is shown on screen (no mail server needed). Chromium is required for video rendering;
Remotion downloads its own headless shell, or set `REMOTION_BROWSER_EXECUTABLE`.

Other useful commands:

```bash
pnpm test         # 1106 tests, no network, no real AI
pnpm e2e          # the whole journey with real browser clicks, from blank page to shared video
pnpm e2e:deliver  # the whole product once, for real: create → ingest → EDL → music → render → authed download
pnpm ai:doctor    # check your configured AI provider(s)
pnpm music:build  # regenerate the bundled music library from seeds
pnpm start:prod   # production boot: migrations + seed, then web + worker under one supervisor
```

To put it on a real URL for the family, see [docs/deploy.md](docs/deploy.md) — a Dockerfile,
docker-compose + Caddy for a small VPS, and Railway/Fly configs, with a 15-minute walkthrough.

## Architecture

pnpm/Turborepo monorepo. SQLite via Drizzle (Postgres-ready conventions), a DB-backed job
queue with a single worker process (no Redis), local-disk blob store behind an interface
(S3-ready), magic-link-only auth with hashed, scoped, revocable tokens, Remotion for video
(the Player preview and the headless render share one composition), ffmpeg for audio and
verification. Hard delete is real: removing a memorial purges rows, blobs, variants, and
renders under one key prefix.

```
apps/web         Next.js 15 — organizer flow, contributor pages, authed media routes
apps/worker      job queue: ingest, photo analysis, EDL generation, rendering
packages/        schemas · db · core · ai · media · storage · video · tradition-packs
content/         bundled music library (CC0, generated, licensed per track)
docs/            ADRs, AI providers, production, Google import, faces, enhancement
```

See [docs/adr/](docs/adr/) for the reasoning behind the big choices.

## Status

The full planned build is complete: the MVP (story + slideshow, end to end), hosted watch
pages and live venue playback, voice interview input, the eulogy studio, the printable
order-of-service program, nine tradition packs, and three config-gated optional features —
Google Photos Picker import, local-only face grouping (nothing leaves the machine), and
opt-in photo enhancement that never touches the original. Each optional feature is genuinely
absent until an operator turns it on; see [docs/production.md](docs/production.md). On top of
that: the family review loop (notes on the draft from viewing links, a co-organizer invite),
song search with half-minute previews, and a deploy kit for Railway, Fly.io, or any small VPS
([docs/deploy.md](docs/deploy.md)).
