# Putting this on a real URL

About fifteen minutes, start to finish, if the domain is already yours.

This is the operator's page. It assumes you can copy and paste into a terminal and nothing else.
[docs/production.md](production.md) is the longer document about running it well — secrets,
storage, Postgres, backups, render hardware. Read this one first, that one before you trust it
with a family's photographs.

---

## What you need

- **A machine, or an account with somebody who has one.** $6–20 a month. Railway and Fly.io both
  work out of the box; so does any $10 VPS.
- **About 2 GB of RAM**, and more if you can. A 1080p render needs 2 GB to itself, and faster
  cores finish it sooner than more cores do (the numbers are at the bottom of this page).
- **20 GB of disk to start.** Roughly 25 MB per memorial for photographs, plus 100–400 MB per
  finished video, and videos accumulate.
- **A domain, optionally.** Railway and Fly both hand you a working https address, so you can
  skip this and add a real name later.
- **An email account with Resend, optionally.** Without one, sign-in links are printed in the
  server log and shown on screen, which is enough to walk the whole product yourself.

Everything runs in one container: the web app and the worker together. That is not a
simplification — they share one SQLite file and one directory of photographs, so they have to be
on the same machine. `scripts/start-prod.mjs` runs the migrations, loads the music library, starts
both, and stops both when the platform asks it to.

---

## First: make the two secrets

Do this before anything else, and keep them somewhere you will still have next year.

```bash
openssl rand -base64 48     # SESSION_SECRET
openssl rand -base64 48     # LINK_SECRET  — a different one
```

`SESSION_SECRET` signs the organiser's session cookie. In production the app refuses to start
without it. Changing it later signs everybody out, which is safe — they get a new link by email.

`LINK_SECRET` is what family collection links and private viewing links are derived from. **Set it
once and never change it.** Changing it turns off every link that has already been shared,
including a QR code that may already be printed on the back of an order of service.

The third thing to decide now is `APP_BASE_URL`: the public https address, with no trailing slash.
Links are composed against it and are opened in somebody's email app, not in the tab that made
them, so a wrong value here is a link that opens nothing.

---

## Railway (the shortest path)

1. Push this repository to GitHub, or fork it.
2. In Railway: **New Project → Deploy from GitHub repo**, and pick it. `railway.json` is already
   here, so Railway builds the `Dockerfile` rather than guessing.
3. **Variables** → add:

   ```
   SESSION_SECRET   the first random string
   LINK_SECRET      the second one
   APP_BASE_URL     https://<whatever Railway gave you>
   ```

   Leave the rest alone. The image already sets `DATABASE_URL=file:/data/app.db`,
   `STORAGE_DIR=/data/blobs`, the browser path and the port.

4. **Settings → Volumes → New Volume**, mount path `/data`. Do this before the first real use.
   Without it, everything works and everything is erased on the next deploy.
5. **Settings → Networking → Generate Domain**, then correct `APP_BASE_URL` to match it.
6. Deploy. The first build takes several minutes; it installs ffmpeg and Chromium.

One service, one replica. Do not scale it up: two containers would be two programs writing one
SQLite file, and the second one is where a family's afternoon goes missing. `railway.json` already
sets `numReplicas: 1` and `overlapSeconds: 0` for that reason — the old container is gone before
the new one starts.

---

## Fly.io

```bash
fly launch --no-deploy --copy-config      # keeps this repo's fly.toml
fly volumes create col_data --size 20     # same region as the app
fly secrets set \
  SESSION_SECRET="…" \
  LINK_SECRET="…" \
  APP_BASE_URL="https://<your-app>.fly.dev"
fly deploy
```

Edit `app` and `primary_region` in `fly.toml` first. Two settings in there are deliberate and
worth leaving alone:

- **`auto_stop_machines = "off"`.** Fly's usual money-saver stops a machine when nobody is
  browsing. The worker lives in that machine, and a stopped machine renders nothing — a family
  would wait all evening for a video that was never being made.
- **`[[vm]] cpu_kind = "performance"`.** A shared-cpu machine will technically render. It will
  also take most of a day.

One machine. A volume attaches to one machine at a time, which is the same single-writer rule as
above, enforced by Fly rather than by hope.

---

## Your own machine, with a domain (the VPS path)

Any Ubuntu or Debian box with Docker on it.

1. Point the domain's **A record** at the machine's IP address, and wait for it to resolve. Caddy
   cannot get a certificate for a name that does not point at it yet.

2. On the machine:

   ```bash
   git clone <this repo> celebration && cd celebration
   cp .env.example .env
   ```

3. Edit `.env` and set four things:

   ```
   COL_DOMAIN=remembering-jean.example.com
   APP_BASE_URL=https://remembering-jean.example.com
   SESSION_SECRET=…
   LINK_SECRET=…
   ```

4. ```bash
   docker compose up -d --build
   ```

That is the whole thing. Caddy gets the HTTPS certificate on first start and renews it forever;
there is nothing to schedule. `deploy/Caddyfile` is three settings long, and each one is explained
in the file.

```bash
docker compose logs -f app       # what the app and the worker are doing
docker compose logs caddy        # certificate trouble shows up here
docker compose down              # stop; the data volume stays
```

---

## After it boots: the ten-minute walk

Do this once, yourself, before you tell a family about it.

1. **Open the address.** You should get the front page, not a certificate warning.
2. **Check `/api/health`.** It answers `{"ok":true,"ffmpeg":true,…}`. If `ffmpeg` is false, video
   rendering will fail and nothing else will.
3. **Create a memorial** and ask for the sign-in link.
   - With the default `MAIL_TRANSPORT=console`, the link is printed in the log
     (`docker compose logs app`, `railway logs`, `fly logs`) and shown on screen. That is normal
     and is enough to keep going.
   - With `MAIL_TRANSPORT=resend`, `RESEND_API_KEY` and a `MAIL_FROM` on a verified domain, it
     arrives by email instead. Mail is sent through the job queue, so a slow provider is a delay
     rather than an error on the day of a funeral.
4. **Upload three photographs from a phone.** This exercises the upload path, the reverse proxy's
   body limit and the blob store all at once.
5. **Make a quick, small copy of the video to check.** Watch the log: the worker claims the job,
   Chromium starts, and a file appears. This is the step that proves ffmpeg, Chromium and the
   volume are all real. A short one takes a few minutes.
6. **Share a viewing link and open it on a device that has never seen the site.**

If step 5 fails with "no Chromium could be found", the image's
`REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium` has been overridden by something. Unset it and let
the app find its own.

---

## Backups

`/data` is everything: the database, every photograph, every finished video. Snapshot the volume
and you have backed up the product.

The one rule that matters: **blobs first, then the database.** A backup with a photograph nothing
points at is harmless; a backup with a row pointing at a photograph that was never copied is a
photograph the family cannot see. And never copy a live SQLite file — use the online backup API.
[docs/production.md §8](production.md) has the commands, the retention argument, and what hard
delete means for the backups.

---

## Upgrading

```bash
git pull
docker compose up -d --build      # or: fly deploy / push to Railway
```

Migrations run at boot, every boot, and are idempotent — so is loading the music library. There is
no separate migration step to remember, and no step to forget at eleven at night.

Stopping is graceful on purpose. The first `SIGTERM` asks the worker to finish the job it is
holding; a render can take a while, so after `COL_SHUTDOWN_GRACE_MS` (25 seconds by default) it is
asked again, which abandons that job. An abandoned job is not a lost one: its lease expires and
the next worker to start picks it up. If either half crash-loops — five restarts in a minute — the
supervisor stops everything and exits non-zero, so the platform restarts the whole container
instead of quietly running half a product.

---

## What is inside the container, if you need to know

- **It does not run as root.** The image starts as root only long enough to make `/data` writable
  — a volume from Fly, Railway or Docker arrives owned by root — and then drops to the image's
  unprivileged `node` user (`deploy/docker-entrypoint.sh`). Remotion always launches Chromium with
  `--no-sandbox`, so nothing here needs privileges. If you mount `/data` somewhere else, set
  `COL_DATA_DIR` to match, or hand the directory over yourself.
- **The image carries development dependencies.** The worker is not compiled: it runs TypeScript
  through `tsx`, and so do the migrations. `pnpm deploy --prod` would strip that out and leave a
  web app with no worker, which is the failure that looks like nothing is wrong. The image is
  roughly 2–3 GB as a result.
- **`/data` holds three things:** `app.db` (with its `-wal` and `-shm` companions), `blobs/`, and
  the finished videos inside `blobs/`.
- **The container's own command is `node scripts/start-prod.mjs`**, not `pnpm start:prod`. One
  process fewer between the platform's `SIGTERM` and the supervisor that has to act on it.

---

## What this is not

Honest limits, so nobody discovers them on a Tuesday afternoon.

- **One machine.** SQLite, one directory of files, one worker. It is a genuinely good fit for one
  organiser and a handful of contributors per memorial — and it is not a multi-tenant SaaS kit.
  Moving to Postgres is a real path, written up in
  [docs/production.md §5](production.md), and it is a day's work, not an afternoon's.
- **Renders are CPU-bound and slow**, deliberately: software rasterisation renders the same on
  every machine, which is what makes the preview and the file identical. Measured on four 2.1 GHz
  cores with no GPU ([ADR 0002](adr/0002-render-and-music.md)):

  | preset                | frames/second | a 5-minute service cut |
  | --------------------- | ------------- | ---------------------- |
  | draft360 (640×360)    | 9.8           | ~15 min                |
  | backup720 (1280×720)  | 4.0           | ~37 min                |
  | final1080 (1920×1080) | 2.0           | ~75 min                |

  A laptop is several times faster. A GPU does not help without giving up the guarantee that the
  preview is the file.

- **Viewing costs bandwidth.** Nothing here hands out a public or presigned URL, so every
  photograph and every video is streamed through the app and checked there. A hundred people
  watching at once is a hundred streams through your box.
- **No SMTP.** Resend or the console log. Adding SMTP is one small class —
  [docs/production.md §3](production.md).

---

## What was and was not tried

Being straight about this, because a deployment guide that overstates itself costs somebody an
evening.

**Proven, by running it:**

- `pnpm start:prod` boots on a plain Linux host with Node 22, ffmpeg and Chromium: migrations run,
  the music library seeds, `next start` serves, the worker polls.
- The web app answers `/api/health`, `/`, `/new` and `/resume` with 200 in that production boot.
- The worker claimed and completed a queued job while under the supervisor.
- Booting a second time against the same data directory is a no-op: migrations apply nothing new
  and the music library reports every track already there.
- `SIGTERM` stops both children and exits 0, with nothing left behind.
- A missing `SESSION_SECRET` refuses to start, and a child that crash-loops brings the whole
  supervisor down with a non-zero exit.

**Written and reviewed, but never executed:**

- **The Dockerfile was never built.** The machine it was written on could not reach a container
  registry, so no image exists. The runtime steps it encodes were run directly on that host
  instead, which is what the list above is. Expect to fix a Debian package name or a base image
  tag on your first `docker build`, and treat the first build as the thing to watch.
- **docker-compose, Caddy, Fly and Railway were never deployed** from there either. The
  configuration files are consistent with each other and with `.env.example` — same port, same
  `/data`, same variable names — but no certificate was ever issued and no volume was ever
  mounted by a platform.

What to check first on a real box, in order: the image builds; the container starts and
`/api/health` answers; `/data` survives a restart with the memorial still in it; a small render
finishes.

---

## Troubleshooting

**Sign-in seems to work, then immediately signs you out.** The session cookie is `secure` in
production, so the app is unusable over plain http by design. Either the origin is not https, or
the proxy is not passing the scheme through.

**Uploads from a phone fail on the big ones.** The reverse proxy's body limit. `deploy/Caddyfile`
sets 512 MB; nginx wants `client_max_body_size 512m` and buffering off — see
[docs/production.md §2](production.md).

**Videos will not seek in the browser.** Something in front of the app is buffering responses.
Range requests have to reach the app untouched.

**`Cannot find module 'better-sqlite3'` in the web app's log.** The two native modules are kept
out of the server bundle on purpose, so the built app loads them from `node_modules` at runtime.
`scripts/start-prod.mjs` finds them and passes their location to the web process; you will only
see this if the web app was started some other way. Start it with `pnpm start:prod`, or the
container's own command.

**The worker is running but nothing happens.** Check it is looking at the same database: the web
app and the worker must have identical `DATABASE_URL` and `STORAGE_DIR`. In one container they
always do.
