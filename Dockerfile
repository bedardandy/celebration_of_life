# syntax=docker/dockerfile:1
#
# One image, one container: the web app and the worker together.
#
# They share a SQLite file and a blob directory, so they cannot be two services
# on two machines. `scripts/start-prod.mjs` runs migrations, seeds the music
# library, then supervises both — see docs/deploy.md.
#
# Build:  docker build -t celebration-of-life .
# Run:    docker run -p 3000:3000 -v col-data:/data \
#           -e SESSION_SECRET=... -e LINK_SECRET=... \
#           -e APP_BASE_URL=https://memorial.example.com celebration-of-life
#
# NOTE: this file was written and reviewed but never built — the environment it
# was authored in has no reachable container registry. Expect to fix a package
# name or two on your first build, and see docs/deploy.md, "What was and was not
# tried".

# --------------------------------------------------------------------- build --
FROM node:22-slim AS build

# NODE_ENV is deliberately not set here: pnpm treats NODE_ENV=production as
# `--prod` and would skip devDependencies, which is where `next` and `tsx` live.
# `next build` produces a production build regardless.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1

# better-sqlite3 and sharp ship prebuilt binaries for linux/amd64 and fall back
# to compiling from source when one does not match (an arm64 host, a new Node).
# Without a toolchain that fallback fails at install time, which is a confusing
# place to find out.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Manifests first, so a change to source code does not reinstall the world.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/media/package.json packages/media/
COPY packages/schemas/package.json packages/schemas/
COPY packages/storage/package.json packages/storage/
COPY packages/tradition-packs/package.json packages/tradition-packs/
COPY packages/video/package.json packages/video/

# The full install, development dependencies included, on purpose:
#   * the worker is not compiled — it runs TypeScript source through `tsx`,
#     which is a development dependency of @col/worker;
#   * every @col/* package is published as source and is loaded the same way.
# `pnpm deploy --prod` and `pnpm prune --prod` both remove tsx and leave a
# container that starts a web app and no worker, which is the worst of the
# available failures: renders queue up and nothing says why. So: one install,
# copied whole. The image is large (roughly 2–3 GB); a family's video is worth
# more than the disk.
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# turbo build → `next build` in apps/web. Nothing else has a build step.
RUN pnpm build

# Build leftovers that would otherwise be copied into the runtime image.
RUN rm -rf .turbo apps/*/.turbo packages/*/.turbo \
    apps/web/.next/cache apps/web/test-results apps/web/playwright-report \
    && find apps packages -name '*.tsbuildinfo' -delete

# ------------------------------------------------------------------- runtime --
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

# Everything the product keeps lives under one directory, so a backup is one
# directory and a volume is one mount.
ENV DATABASE_URL=file:/data/app.db \
    STORAGE_DIR=/data/blobs

# Debian's Chromium, so Remotion never tries to download one mid-render.
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium

# A working demo with no keys and no model, and sign-in links printed to the
# log. Set AI_PROVIDER (docs/ai-providers.md) and MAIL_TRANSPORT=resend when
# there is a real model and a real mailbox.
ENV AI_PROVIDER=mock \
    AI_FIXTURES_DIR=/app/fixtures/ai \
    MAIL_TRANSPORT=console

# ffmpeg + ffprobe: the product's one system prerequisite.
# chromium: what Remotion renders through.
# fonts: a render with no fonts installed draws tofu where a person's name goes.
# tini: PID 1 that reaps the processes Chromium leaves behind.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        chromium \
        fonts-liberation \
        fonts-dejavu-core \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node:22-slim already has an unprivileged `node` user (uid 1000). Remotion
# always launches Chromium with --no-sandbox and --disable-setuid-sandbox (see
# @remotion/renderer's open-browser), so nothing here needs root — the container
# is the boundary, and one less root process is one less thing to explain.
# The entrypoint starts as root only long enough to make /data writable by this
# user, because a platform volume (Fly, Railway) arrives owned by root.
COPY --from=build --chown=node:node /app /app
COPY --chmod=0755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data && chown node:node /data

# The database, the blobs and the finished videos. Snapshot this and you have
# backed up everything — see docs/production.md §8.
VOLUME ["/data"]

EXPOSE 3000

# Cheap and honest: it reports the app is answering, and whether ffmpeg is
# there. The check is memoised in-process, so this does not spawn ffmpeg.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "scripts/start-prod.mjs"]
