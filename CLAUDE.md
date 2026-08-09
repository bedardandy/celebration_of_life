# CLAUDE.md — working on this repo

A toolkit that helps grieving families create the media for a funeral or celebration of life.
The people using it are grieving, often older, often on a 3–7 day deadline. That fact shapes
every technical decision here; read [docs/plan.md](docs/plan.md) for the full design rationale
and [docs/copy-guide.md](docs/copy-guide.md) before writing any user-facing text.

## State of the build

All planned phases (0–8) are complete and on `main`'s feature branch
`claude/celebration-life-media-toolkit-of6mx0`. The product works end to end: memorial →
photo collection via contributor links → AI interview → curation → EDL → Remotion preview →
music → rendered MP4 → private watch links with family notes → eulogy studio → printed
program → deploy kit. 1106 tests + a Playwright e2e that drives the whole journey with real
clicks (`pnpm e2e`, ~1 minute).

Optional, config-gated features (genuinely absent when unconfigured — no dead buttons):
Google Photos import, local-only face grouping, photo enhancement, Resend email, S3 storage.
Activation for all of them: [docs/production.md](docs/production.md) §7 and
[docs/deploy.md](docs/deploy.md).

### Known unproven edges (blocked by this dev container's egress policy, not by code)

- The Dockerfile has never been `docker build`t (no registry access here). The prod boot path
  it encodes is proven directly (`pnpm start:prod`).
- The iTunes song-audition mapper was written against fixtures; itunes.apple.com was
  unreachable. A wrong live shape degrades to "no results", never an error.
- The ONNX face engine loads and probes correctly but has never run real model weights.

## Commands

```bash
pnpm dev            # web :3000 + worker
pnpm test           # full suite, offline, AI mocked (NODE_ENV=test forces mock provider)
pnpm e2e            # Playwright happy path (browsers at /opt/pw-browsers — NEVER `playwright install`)
pnpm e2e:deliver    # real render end-to-end script
pnpm lint && pnpm typecheck
pnpm --filter @col/web build
pnpm start:prod     # production boot: migrations + seed, then web + worker supervised
pnpm ai:doctor      # live-check configured AI providers
```

Verification bar for any change: lint, typecheck, full test suite, web build, and `pnpm e2e`
if web UI or flows changed. ffmpeg must be on PATH (installed via apt here).

## Conventions that are load-bearing

- **Grief rules** (non-negotiable, enforced in review): one decision per screen, everything
  autosaves, everything undoable, no blank pages, ≥48px targets, nothing autoplays, no
  upsells, plain warm copy at ~grade 6. Voice examples in docs/copy-guide.md.
- **Verbatim quotes**: any quoted memory (slideshow quote cards, eulogy quotations) must match
  an approved memory word-for-word or the quote marks come off. Never invented words at a
  funeral. Enforcement lives in the EDL generation and eulogy assembly code — keep it.
- **AI proposes, code decides**: AI calls return zod-validated objects via
  `packages/ai` `generateObject` (salvage → repair loop → typed error). Timing math, cut
  projection, and clustering are pure code. All AI is vendor-agnostic behind `resolveProvider`;
  tests may only ever use the mock provider.
- **Faith is data**: tradition packs are JSON in `packages/tradition-packs/data/`. No
  `if (catholic)` anywhere. A new tradition is a new JSON file validated by the loader test.
- **DB**: SQLite via Drizzle with Postgres-portable conventions — text uuidv7 PKs, epoch-ms
  ints, JSON-as-text zod-validated. Migrations are hand-numbered in `packages/db/drizzle/`
  (0000–0006 taken; the journal has a deliberate idx gap at 0003 — preserve it, just append).
- **Auth**: magic links only, hashed + scoped + revocable tokens; shareable links are derived
  HMAC tokens (LINK_SECRET). Possession of a link is the credential — there are no passwords.
- **Privacy**: every blob read is auth-checked; hard delete purges rows + blobs by
  `memorial/{id}/` prefix; face data never leaves the machine; cloud AI is consent-gated.
- **Jobs**: DB-backed queue, single worker process, handlers in `apps/worker/src/handlers/`
  registered in `index.ts`. New job types go in the `packages/schemas` jobs union first.
- **Video**: the `@remotion/player` preview and the headless render share one composition;
  renders pin `colorSpace: 'bt709'` (venue-projector bug) and are ffprobe-verified before a
  job may report done. Chromium is discovered at /opt/pw-browsers (remotion.media is blocked
  in dev containers).

## Multi-agent execution conventions (used to build this; reuse for future phases)

Parallel subagents each get: a written spec with explicit file ownership (siblings never touch
each other's files; shared files get "small additive edits only"), an assigned migration
number, an assigned port range (3300+ in tens), and a no-commit rule — the orchestrator
verifies everything independently and makes the commit. Playwright version is pinned to match
the preinstalled browsers; never run `playwright install`.

## Where to pick up next (ideas discussed, not committed to)

- First real deploy (Railway/Fly/VPS) + first `docker build` — docs/deploy.md is the script.
- One live iTunes search + one real face-model run to close the two unproven edges.
- Possible future: timestamped notes threaded into re-render diffs, SMTP transport,
  half-fold program imposition, Postgres migration in anger (conventions are ready).
