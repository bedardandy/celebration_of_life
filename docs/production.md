# Running this in production

Everything below is optional except the secrets. A single machine with SQLite on a disk and the
local blob store is a real deployment, not a demo — it is the one this product was designed
around, and it is what most families' data should sit on.

Read this end to end before the first deploy. The rest can wait.

---

## 1. The two secrets, which are not optional

```
SESSION_SECRET=<48 random bytes, base64>     # openssl rand -base64 48
LINK_SECRET=<48 random bytes, base64>        # a *different* 48
```

`SESSION_SECRET` signs the organiser's session cookie (HMAC-SHA256). In development a missing one
falls back to an insecure default and warns; **in production the app refuses to start without it**,
which is deliberate: a forgeable session cookie is worse than an app that will not boot.

`LINK_SECRET` derives shareable links — the family collection link, personal asks, and private
viewing links. The database stores only their hashes, so this is what lets an organiser be shown
the same link again next Thursday, including the QR code already printed on the back of an order
of service. It defaults to `SESSION_SECRET` if unset.

Consequences worth knowing before you rotate either one:

- Rotating `SESSION_SECRET` signs everybody out. That is safe; they get a new link by email.
- **Rotating `LINK_SECRET` turns every existing shared link off at once.** Printed QR codes stop
  working. Set it once, alongside `SESSION_SECRET`, and leave it alone. The code reports this
  honestly rather than papering over it (`recoverShareableToken` returns nothing, and the screen
  offers to make a fresh link).

Set `APP_BASE_URL` to the public HTTPS origin. Links are composed against it and are read in
somebody's email client, not in the tab that made them, so a wrong value here is a link that opens
nothing.

---

## 2. HTTPS, cookies and the reverse proxy

Terminate TLS at a reverse proxy (nginx, Caddy, a load balancer) and forward to the app.

The session cookie is `httpOnly`, `sameSite=lax`, and `secure` in production — which means **the
app is unusable over plain http in production**, by design. If sign-in appears to work and then
immediately signs the person out, the cookie is being dropped because the origin is not https or
because the proxy is not passing the scheme through.

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;

    # Videos are streamed, and range requests must reach the app untouched or
    # seeking on the watch page stops working.
    proxy_buffering    off;
    proxy_request_buffering off;
    client_max_body_size 512m;   # a phone's HEIC burst is bigger than you think
    proxy_read_timeout 300s;     # long uploads on a rural connection
}
```

Do not put a cache in front of `/api/`. Every response there is `cache-control: private, no-store`
for a reason: it is one family's photographs and one family's video.

---

## 3. Email

Development prints the magic link to the server log and shows it on screen, so the whole product is
walkable without a mailbox. Production needs a real transport.

```
MAIL_TRANSPORT=resend
RESEND_API_KEY=re_...
MAIL_FROM=Celebration of Life <hello@yourdomain.example>
```

Setting up Resend:

1. Create an account and add your sending domain.
2. Add the DKIM and SPF records it gives you to DNS, and wait for it to verify. A `from` address on
   an unverified domain is refused with a 403, which surfaces as a queued job retrying.
3. Create an API key with send permission only.
4. Set the three variables above. `MAIL_FROM` must be on the verified domain.

**In production, mail goes through the job queue** rather than being sent inside the request
(`deliverEmail` → a `send-email` job → the worker). This is not for throughput. It is so that the
afternoon your mail provider is down, an organiser pressing "send me my link again" sees the same
calm screen and gets the email a minute later, instead of a 500 on the day of a funeral. The queue
retries five times with backoff. The queued row carries a template name and its facts, never the
composed prose — a message about a bereaved family should not sit in a database as text.

Every message is plain text. A magic link inside HTML is a link some mail clients rewrite, wrap or
shorten, and a link that arrives broken is not a small bug here.

**SMTP is not implemented.** Adding it means one class implementing `MailTransport` plus a mailer
dependency (`nodemailer`); it was left out rather than pull in a dependency for a path nobody in
this deployment needs yet. If you need it, add `packages/core/src/mail/smtp.ts` and a case in
`getMailTransport()` — the interface is two methods wide.

---

## 4. Storage

### Local disk (the default)

```
STORAGE_DIR=/var/lib/celebration/blobs
```

Keys are `memorial/{id}/…` so a hard delete is one prefix removal. Give it real space: about
25 MB per memorial for photographs and their variants, plus 100–400 MB per finished render, and
renders accumulate (a service cut and a family cut, at three presets each).

### S3-compatible object storage

```
STORAGE_DRIVER=s3
S3_BUCKET=celebration-blobs
S3_REGION=eu-west-1
# Everything except AWS:
# S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
# S3_FORCE_PATH_STYLE=1          # MinIO
# S3_KEY_PREFIX=prod             # sharing a bucket
# Omit both to use the instance's own role/credentials:
# S3_ACCESS_KEY_ID=...
# S3_SECRET_ACCESS_KEY=...
```

`S3Store` implements the same `BlobStore` interface (AWS S3, MinIO, Backblaze B2, Cloudflare R2,
Wasabi). Install the optional dependency: `pnpm add @aws-sdk/client-s3`.

Two things are deliberate and worth understanding before you switch:

- **The bucket must be private, and there are still no public URLs.** Nothing in this product
  hands out a presigned link, because a presigned link outlives a revoked viewing link. Every read
  is streamed through the app and auth-checked there. That means the app's bandwidth is the
  viewing bandwidth — size the box accordingly if you expect a hundred people to watch at once.
- **`S3Store` has no `getPath`.** ffmpeg and Remotion want real files, so anything that shells out
  copies the object into a scratch directory first; the render handler already does this
  (`materialise`). The absence is the honest signal — advertising a path that cannot be honoured
  would break renders only in production.

`deletePrefix` pages through every key and batches deletes at a thousand, because "hard delete is
real" is a promise this product makes in writing.

The store is chosen once at boot (`initBlobStore`) — from Next's instrumentation hook in the web
app, and before the first claimed job in the worker — because `getBlobStore()` is synchronous at
every call site.

---

## 5. Database: SQLite now, Postgres when you need it

SQLite (better-sqlite3) is the default and is genuinely fine for this workload: one organiser and
a handful of contributors per memorial, a job queue with second-scale latency, and no read replica
in sight. Use WAL mode (the client already does) and put the file on local disk, never on NFS.

```
DATABASE_URL=file:/var/lib/celebration/app.db
```

### Moving to Postgres

The schema was written to be portable from the first migration, so this is a real path rather than
a rewrite. The conventions that make it work, all already in place:

- primary keys are text UUIDv7 — no sequences, no `AUTOINCREMENT`
- timestamps are integer epoch-milliseconds — never SQLite date strings
- JSON lives in `text` columns validated by zod at the boundary — never SQLite-specific types
- booleans are `integer` with `{ mode: 'boolean' }`
- soft delete is a `deletedAt` column; hard delete is a separate, real purge

The concrete steps:

1. `pnpm add pg drizzle-orm` (drizzle is already there) and add `packages/db/src/schema.pg.ts`
   using `pg-core` — the same table definitions with `pgTable`, `text`, `bigint`, `jsonb`.
2. Point `drizzle.config.ts` at the new schema with `dialect: 'postgresql'` and generate a fresh
   initial migration. Do **not** try to translate the SQLite migrations one by one; generate a new
   baseline from the schema and migrate data separately.
3. Swap the client in `packages/db/src/client.ts` on a `DATABASE_URL` scheme check
   (`file:` → better-sqlite3, `postgres://` → node-postgres). `type Db` is the seam everything else
   depends on.
4. Move the data with a script that reads every table through drizzle and writes it through the
   Postgres client, in foreign-key order (the order in `TABLE_NAMES`). At the scale this product
   runs at, a single-process copy is measured in seconds.

Gotchas that will bite, in the order they will bite you:

- **`.all()` / `.run()` / `.get()` are better-sqlite3's synchronous API.** The Postgres driver is
  asynchronous. Every query in `packages/core` will need `await`. This is the actual work of the
  migration and it is mechanical; budget a day, not an hour.
- **`insertOne`/`updateById`/`listWhere` in `packages/db/src/helpers.ts` are the choke point.**
  Change them first; most call sites follow.
- **Epoch-millisecond timestamps exceed a 32-bit `integer` in Postgres.** They must be `bigint`,
  and drizzle returns `bigint` columns as strings by default — set the parser or use
  `mode: 'number'`.
- **JSON columns:** SQLite stores validated text. `jsonb` in Postgres will reorder keys. Nothing
  compares JSON text for equality, but do not start.
- **The job queue's lease claim** (`claimNext`) relies on a single writer. On Postgres, change it
  to `SELECT … FOR UPDATE SKIP LOCKED` — otherwise two workers can claim the same render, and two
  workers rendering the same video is a wasted hour on the day it matters.
- **Boolean columns** come back as real booleans on Postgres and as `0`/`1` before drizzle's mode
  mapping. Keep `{ mode: 'boolean' }` on every one.

---

## 6. The worker, and render hardware

The worker is a second process. It must see the same `DATABASE_URL` and the same storage.

```
WORKER_POLL_INTERVAL_MS=1500
WORKER_LEASE_MS=30000
WORKER_MAX_ATTEMPTS=3
# WORKER_JOB_TYPES=render        # a render-only box
# WORKER_ID=render-1
```

**ffmpeg and ffprobe must be on `PATH`** — the product's single system prerequisite. The worker
says so at boot if they are missing, and photo, story and queue work all continue without them;
only renders fail.

Remotion drives a headless Chromium. Any Chromium already on the machine is found automatically
(Playwright and Puppeteer caches, `/usr/bin/chromium`); set `REMOTION_BROWSER_EXECUTABLE` to settle
it outright. With none available and no network to `remotion.media`, renders fail with an
explanation rather than silently.

### What a render actually costs

Rendering is CPU-bound software rasterisation (`gl: 'swangle'`), chosen for determinism: it is the
same on every machine, which is what makes "the preview is the file" true. Measured on four
2.1 GHz cores with no GPU (ADR 0002):

| preset                | frames/second | a 5-minute service cut |
| --------------------- | ------------- | ---------------------- |
| draft360 (640×360)    | 9.8           | ~15 min                |
| backup720 (1280×720)  | 4.0           | ~37 min                |
| final1080 (1920×1080) | 2.0           | ~75 min                |

A developer laptop is several times faster; the practical spread across machines is roughly 2 to
25 fps at 1080p. Concurrency made no difference on that box (2.07 fps at four workers against 2.06
at the default), so the cost is raster and encode throughput, not the composition.

What this means for sizing:

- **Faster cores beat more cores.** Four fast cores will finish a 1080p render in twenty minutes
  where sixteen slow ones take an hour.
- A GPU does not help without changing `gl` away from `swangle`, which would break the
  frame-identical guarantee. Do not.
- Budget **2 GB of RAM per concurrent render** and a scratch directory with room for the
  photographs plus two copies of the output.
- One worker per machine is the right default. If a busy week needs more, run a second machine
  with `WORKER_JOB_TYPES=render` rather than two workers on one box.

The deliver screen never states a number until the render's own progress justifies one, which is
why none of the above is baked into the copy. See `describeRenderProgress`.

---

## 7. The three optional features, and how to turn them on

Everything below is off in a default deployment, and each one is genuinely absent when it is off —
no card, no button, no route that half-works. Each has its own page; this is the short version.

### Google Photos import — [docs/google-photos.md](google-photos.md)

```
GOOGLE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
```

An operator must: create a Google Cloud project, **enable the Photos Picker API** (not the Photos
Library API — that one closed to third parties in March 2025), configure the OAuth consent screen
with the single scope `photospicker.mediaitems.readonly`, add the organisers as **test users**
(or take the app through Google's verification review, which takes weeks), create a Web
application OAuth client with the redirect URI `${APP_BASE_URL}/api/import/google/callback`
character for character, then set the two variables **on both the web app and the worker** and
restart. Access tokens are never stored: they travel to the worker sealed with a key derived from
`SESSION_SECRET`, and are blanked from the job row when the import finishes.

### Face grouping — [docs/face-grouping.md](face-grouping.md)

```
FACE_ENGINE=onnx
FACE_MODEL_DIR=/var/lib/celebration/models
```

An operator must: install the optional runtime (`pnpm add -O onnxruntime-node --filter @col/media`),
download the two InsightFace `buffalo_s` models on a machine that has a network — `det_500m.onnx`
(detector) and `w600k_mbf.onnx` (embedder) — put them in `FACE_MODEL_DIR`, set the two variables on
the **worker**, and restart it. The boot log says which engine loaded, or exactly which file it
could not find. Nothing in this product ever downloads a model, and no face data ever leaves the
machine. `FACE_ENGINE=mock` is for tests and development only — it produces confident, meaningless
groups.

### Photo enhancement — [docs/photo-enhancement.md](photo-enhancement.md)

Needs no configuration: the built-in sharp restorer is always available, opt-in per photograph,
and never replaces the original. To swap in a heavier restorer, set on the worker:

```
RESTORER_CMD="python /opt/CodeFormer/inference_codeformer.py -w 0.7 --input_path {in} --output_path {out}"
```

Read the fidelity warning in that document before you do. A face restorer **invents** detail, and
CodeFormer's `w≈0.7` exists precisely so the result stays the person the family remembers.

---

## 8. Backups

Two things need backing up, and they must be consistent with each other.

**The database.** Never copy a live SQLite file — use the online backup API, which is safe while
the app is running:

```bash
sqlite3 /var/lib/celebration/app.db ".backup '/backups/app-$(date +%F-%H%M).db'"
```

**The blobs.** `rsync -a --delete /var/lib/celebration/blobs/ /backups/blobs/`, or object-storage
versioning if you are on S3.

Order matters: **blobs first, then the database.** A backup with a blob that no row references is
harmless clutter; a backup with a row pointing at a blob that was never copied is a photograph the
family cannot see.

Restore is a file copy back and a restart. Test it once, on purpose, before you need it.

Retention deserves a decision rather than a default: this is a family's photographs and their
recording of a funeral. Thirty days of nightly backups, encrypted at rest, held somewhere you can
actually delete from, is a defensible answer. "Forever, on a laptop" is not.

**Hard delete has to reach the backups too.** When a family removes a memorial, the purge removes
the rows and every blob under `memorial/{id}/`. If your backups outlive that, say so in your
privacy notice, and make sure the retention window is short enough that the sentence is bearable.

---

## 9. A production checklist

```
SESSION_SECRET      set, 32+ random bytes, not the dev default
LINK_SECRET         set, different, and never rotated afterwards
APP_BASE_URL        the public https origin, no trailing slash
NODE_ENV            production
DATABASE_URL        an absolute path on local disk
STORAGE_DIR         an absolute path with room to grow (or STORAGE_DRIVER=s3)
MAIL_TRANSPORT      resend, with RESEND_API_KEY and a verified MAIL_FROM
AI_PROVIDER         whichever adapter, with its key — see docs/ai-providers.md
ffmpeg, ffprobe     on PATH (`pnpm --filter @col/worker start` says so at boot)
chromium            present, or REMOTION_BROWSER_EXECUTABLE set
reverse proxy       https, buffering off, 512m body limit
backups             blobs then database, nightly, restore tested once
worker              running, as a separate service, restarted on failure

optional, all off by default:
GOOGLE_OAUTH_*      only with the Picker API enabled and the redirect URI matching exactly
FACE_ENGINE         onnx, with FACE_MODEL_DIR holding both model files (worker only)
RESTORER_CMD        only after reading the fidelity warning in docs/photo-enhancement.md
```

Then walk it: create a memorial, send yourself the link, open it from the email, upload three
photographs from a phone, make a draft video, share a viewing link, and open that link on a device
that has never seen the site. That is the whole product, and it takes ten minutes.
