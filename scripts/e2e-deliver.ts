/**
 * `pnpm e2e:deliver` — the whole product, once, for real.
 *
 * Create a memorial, put photographs through the real ingest pipeline, generate
 * a slideshow, choose music from the bundled library, render the final 1080p
 * video through the real worker, verify it with ffprobe, and then download it
 * through the authorised HTTP route with nothing but a session cookie — exactly
 * as a family would. Every step is the product's own code; nothing here is a
 * stand-in except the AI provider, which is the deterministic mock.
 *
 * It exists because unit tests can all pass while the seams between them are
 * broken, and because the only claim that matters — "there is a file, and it
 * will play" — is a claim about the end of the chain.
 *
 *   pnpm e2e:deliver                  12 photographs, service cut, final1080
 *   pnpm e2e:deliver --photos 60      the realistic case, for timing
 *   pnpm e2e:deliver --preset draft360
 *   pnpm e2e:deliver --keep           leave the working directory behind
 *
 * The HTTP step needs a production build of the web app (`pnpm build:web`); it
 * is skipped with a warning if there is not one, and the rest still runs.
 */
/* eslint-disable no-console */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/* -------------------------------------------------------------------------- */
/* arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const PHOTO_COUNT = Number(flag('photos', '12'));
const PRESET = flag('preset', 'final1080') as 'draft360' | 'final1080' | 'backup720';
const CUT = flag('cut', 'service') as 'service' | 'family';
const KEEP = has('keep');

/* -------------------------------------------------------------------------- */
/* an isolated world                                                           */
/* -------------------------------------------------------------------------- */

const workdir = mkdtempSync(path.join(tmpdir(), 'col-e2e-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'e2e.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'e2e-deliver-secret';
process.env['AI_PROVIDER'] = 'mock';
process.env['APP_BASE_URL'] = 'http://127.0.0.1';
process.env['LOG_LEVEL'] = 'warn';

const {
  approvedAssets,
  assembleEdl,
  buildContext,
  bundledTracks,
  chooseClearedTrack,
  createMemorial,
  deliverableFilename,
  describeLength,
  encodeSession,
  generateEdl,
  getOrCreateProject,
  ingestAsset,
  plainProposal,
  projectCut,
  projectEdl,
  requestRender,
  saveEdl,
  seedMusicLibrary,
  toggleApproval,
} = await import('../packages/core/src/index');
const {
  ensureDatabase,
  getById,
  getDb,
  insertOne,
  mediaAssets,
  newId,
  renderJobs,
  slideshowProjects,
} = await import('../packages/db/src/index');
const { blobKeys, getBlobStore } = await import('../packages/storage/src/index');
const { probe } = await import('../packages/media/src/ffmpeg');
const { isFaststart, measureLoudness } = await import('../packages/media/src/audio');
const { runOnce } = await import('../apps/worker/src/runner');
const { setRenderBlobStore } = await import('../apps/worker/src/handlers/index');

const FIXTURE_PHOTOS = path.join(repoRoot, 'fixtures', 'photos');

const silent = {
  debug() {},
  info() {},
  warn() {},
  error(message: string, fields?: Record<string, unknown>) {
    console.error(`  ! ${message}`, fields ?? '');
  },
  child() {
    return silent;
  },
};

type Step = { name: string; ms: number; note?: string };
const steps: Step[] = [];

async function step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  process.stdout.write(`  ${name} … `);
  const startedAt = Date.now();
  const result = await run();
  const ms = Date.now() - startedAt;
  steps.push({ name, ms });
  console.log(`${(ms / 1000).toFixed(1)}s`);
  return result;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`\nEnd-to-end delivery run — ${PHOTO_COUNT} photographs, ${CUT} cut, ${PRESET}.`);
  console.log(`Working in ${workdir}\n`);

  ensureDatabase();
  const db = getDb();
  const store = getBlobStore();
  setRenderBlobStore(store);

  /* 1. a family arrives -------------------------------------------------- */

  const { memorial, organizer } = createMemorial(db, {
    decedentName: 'Ruth Anne Kelleher',
    organizerName: 'Anne Doyle',
    organizerEmail: 'anne@example.test',
  });
  console.log(`  memorial ${memorial.id} for ${memorial.decedentName}`);

  /* 2. photographs, through the real ingest pipeline ---------------------- */

  const sources = await fixturePhotos();
  await step(`ingest ${PHOTO_COUNT} photographs`, async () => {
    for (let i = 0; i < PHOTO_COUNT; i += 1) {
      const source = sources[i % sources.length] as { file: string; bytes: Buffer };
      const assetId = newId();
      const key = blobKeys.original(memorial.id, assetId, 'jpg');
      await store.put(key, source.bytes, 'image/jpeg');
      insertOne(db, mediaAssets, {
        id: assetId,
        memorialId: memorial.id,
        originalFilename: path.basename(source.file),
        mime: 'image/jpeg',
        byteSize: source.bytes.byteLength,
        blobKey: key,
        // Spread across a lifetime so the story has decades to work with.
        capturedAt: Date.UTC(1948 + Math.floor((i / PHOTO_COUNT) * 60), (i * 5) % 12, 1 + (i % 27)),
        ingestState: 'uploaded',
      } as never);
      await ingestAsset(db, store, { assetId, blobKey: key });
      // A family taps each photograph they want; every one here is a keeper.
      toggleApproval(db, memorial.id, assetId);
    }
  });

  const approved = approvedAssets(db, memorial.id);
  console.log(`  ${approved.length} photographs approved`);

  /* 3. the slideshow ------------------------------------------------------ */

  const project = getOrCreateProject(db, memorial.id);
  await step('generate the slideshow (mock AI)', async () => {
    const context = buildContext(db, memorial.id, project.id);
    const result = await generateEdl(context);
    let edl = result.edl;

    // The mock provider answers from a fixture, so its proposal names a fixed
    // handful of photographs however many were uploaded. When that happens we
    // fall back to the *plain* ordering — the same code path a family without
    // AI consent gets — so a sixty-photograph run really renders sixty
    // photographs rather than the fixture's six.
    const photoSlides = Object.values(edl.slides).filter((slide) => slide.kind === 'photo').length;
    if (photoSlides < context.assets.length) {
      edl = assembleEdl(plainProposal(context), context).edl;
      console.log(
        `\n  (the mock proposal covered ${photoSlides} of ${context.assets.length} photographs; ` +
          'using the plain ordering so the render is realistic)',
      );
    }
    saveEdl(db, project.id, edl, { status: 'ready' });
  });

  /* 4. music -------------------------------------------------------------- */

  await step('load the music library', () => seedMusicLibrary(db, store));
  const track = bundledTracks(db)[0];
  if (!track) throw new Error('the music library is empty — run `pnpm music:build` first');

  await step(`choose "${track.title}" and re-time to it`, () => {
    chooseClearedTrack(db, { memorialId: memorial.id, projectId: project.id, trackId: track.id });
  });

  const edl = projectEdl(getById(db, slideshowProjects, project.id));
  const timeline = projectCut(edl!, CUT);
  console.log(
    `  ${CUT} cut: ${describeLength(timeline.totalSec)} over ${timeline.slides.length} slides` +
      `, snapped to ${edl?.audio.beatGrid?.bpm ?? '—'} BPM`,
  );

  /* 5. the render --------------------------------------------------------- */

  const { renderJob } = requestRender(db, {
    memorialId: memorial.id,
    projectId: project.id,
    cut: CUT,
    preset: PRESET,
  });

  const renderStartedAt = Date.now();
  await step(`render ${PRESET}`, async () => {
    const result = await runOnce({
      db,
      config: { workerId: 'e2e', pollIntervalMs: 5, leaseMs: 600_000, maxAttempts: 1 },
      logger: silent as never,
    });
    if (result.status !== 'done') {
      throw new Error(
        `the render did not finish: ${result.status}` +
          ('error' in result ? ` — ${result.error}` : ''),
      );
    }
  });
  const renderMs = Date.now() - renderStartedAt;

  const finished = getById(db, renderJobs, renderJob.id);
  if (!finished?.outputBlobKey) throw new Error('the render produced no file');
  const outputPath = store.getPath?.(finished.outputBlobKey);
  if (!outputPath) throw new Error('the store cannot hand back a path');

  /* 6. proof -------------------------------------------------------------- */

  const meta = await probe(outputPath);
  const video = (meta['streams'] as Record<string, any>[]).find((s) => s['codec_type'] === 'video');
  const audio = (meta['streams'] as Record<string, any>[]).find((s) => s['codec_type'] === 'audio');
  const format = meta['format'] as Record<string, any>;
  const durationSec = Number(format['duration']);
  const loudness = await measureLoudness(outputPath);

  console.log('\n  ffprobe says:');
  console.log(
    `    video      ${video?.['codec_name']} ${video?.['pix_fmt']} ${video?.['width']}×${video?.['height']} @ ${video?.['r_frame_rate']}`,
  );
  console.log(
    `    audio      ${audio?.['codec_name']} ${audio?.['sample_rate']} Hz, ${audio?.['channels']} ch`,
  );
  console.log(`    container  ${format['format_name']}`);
  console.log(
    `    faststart  ${(await isFaststart(outputPath)) ? 'yes (moov before mdat)' : 'NO'}`,
  );
  console.log(
    `    length     ${durationSec.toFixed(2)}s (timeline says ${timeline.totalSec.toFixed(2)}s)`,
  );
  console.log(`    loudness   ${loudness?.input_i.toFixed(2)} LUFS`);
  console.log(`    size       ${(Number(format['size']) / 1024 / 1024).toFixed(1)} MB`);

  assert(video?.['codec_name'] === 'h264', 'the video stream must be H.264');
  assert(video?.['pix_fmt'] === 'yuv420p', 'the pixel format must be yuv420p');
  assert(audio?.['codec_name'] === 'aac', 'the audio stream must be AAC');
  assert(String(format['format_name']).includes('mp4'), 'the container must be MP4');
  assert(await isFaststart(outputPath), 'the moov atom must come before mdat');
  assert(
    Math.abs(durationSec - timeline.totalSec) <= 0.5,
    `the file must run within half a second of the timeline`,
  );
  assert(
    Math.abs((loudness?.input_i ?? -99) + 16) <= 1.5,
    'the delivered file must be within 1.5 LU of −16 LUFS',
  );

  /* 7. the download, over HTTP, with a session cookie ---------------------- */

  const filename = deliverableFilename({
    decedentName: memorial.decedentName,
    cut: CUT,
    preset: PRESET,
  });
  await downloadOverHttp({
    renderJobId: renderJob.id,
    filename,
    session: encodeSession({
      participantId: organizer.id,
      memorialId: memorial.id,
      role: 'organizer',
      issuedAt: Date.now(),
    }),
    expectedBytes: Number(format['size']),
  });

  /* 8. what it cost ------------------------------------------------------- */

  console.log('\n  Timings');
  for (const s of steps) console.log(`    ${s.name.padEnd(38)} ${(s.ms / 1000).toFixed(1)}s`);

  const videoSec = timeline.totalSec;
  console.log(
    `\n  ${PRESET} render: ${(renderMs / 1000).toFixed(1)}s of work for ` +
      `${videoSec.toFixed(1)}s of video (${(renderMs / 1000 / videoSec).toFixed(2)}× real time, ` +
      `${(renderMs / 1000 / approved.length).toFixed(2)}s per photograph).`,
  );

  console.log(`\n  The file: ${filename}\n  ${outputPath}\n`);
  console.log('Everything checked out.\n');
}

/* -------------------------------------------------------------------------- */
/* the HTTP step                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Start the built web app, ask it for the video with nothing but a cookie, and
 * check what comes back.
 *
 * This is the only part that needs a build, and it is skipped rather than
 * failed when there is not one — the point of the script is the pipeline, and
 * `pnpm build:web` is not always what somebody wants to wait for.
 */
async function downloadOverHttp(options: {
  renderJobId: string;
  filename: string;
  session: string;
  expectedBytes: number;
}): Promise<void> {
  const built = existsSync(path.join(repoRoot, 'apps/web/.next/BUILD_ID'));
  if (!built) {
    console.log(
      '\n  ! Skipping the HTTP download check: apps/web has no production build.\n' +
        '    Run `pnpm build:web` and try again to exercise the authorised route.',
    );
    return;
  }

  // A free port rather than a fixed one, and Next's own binary rather than
  // `npx`: a wrapper process means `kill` reaches the wrapper and leaves a
  // server holding the port, which the next run then talks to instead — with a
  // database that no longer exists. That failure looks exactly like a broken
  // authorisation check, which is a bad hour to spend.
  const port = await freePort();
  const server: ChildProcess = spawn(
    path.join(repoRoot, 'apps/web/node_modules/.bin/next'),
    ['start', '-p', String(port)],
    {
      cwd: path.join(repoRoot, 'apps/web'),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so nothing it spawns outlives this script.
      detached: true,
    },
  );

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/health`, server);

    const url = `http://127.0.0.1:${port}/api/renders/${options.renderJobId}`;

    const anonymous = await fetch(url, { redirect: 'manual' });
    assert(anonymous.status === 403, `a stranger must be refused (got ${anonymous.status})`);

    const response = await fetch(url, { headers: { cookie: `col_session=${options.session}` } });
    if (response.status !== 200) {
      throw new Error(
        `the organiser must be served (got ${response.status}: ${(await response.text()).slice(0, 200)})`,
      );
    }

    const disposition = response.headers.get('content-disposition') ?? '';
    assert(
      disposition.includes(options.filename),
      `the download must be named ${options.filename} (got ${disposition})`,
    );
    assert(
      (response.headers.get('content-type') ?? '') === 'video/mp4',
      'the download must be served as video/mp4',
    );

    const bytes = Buffer.from(await response.arrayBuffer());
    assert(
      bytes.byteLength === options.expectedBytes,
      `the download must be the whole file (${bytes.byteLength} of ${options.expectedBytes} bytes)`,
    );

    // And the bytes that came down the wire are themselves a playable file.
    const downloaded = path.join(workdir, options.filename);
    await writeFile(downloaded, bytes);
    const meta = await probe(downloaded);
    const video = (meta['streams'] as Record<string, any>[]).find(
      (s) => s['codec_type'] === 'video',
    );
    assert(video?.['codec_name'] === 'h264', 'the downloaded file must still be H.264');

    console.log('\n  Downloaded over HTTP with a session cookie:');
    console.log(`    403 without a session, 200 with one`);
    console.log(
      `    ${options.filename} — ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, verified again after download`,
    );
  } finally {
    stop(server);
  }
}

/** Kill the server and anything it started, by process group. */
function stop(server: ChildProcess): void {
  if (server.pid == null) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

/** A port the kernel just told us was free. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the web server exited (${server.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`the web server never came up: ${String(lastError)}`);
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The fixture photographs, read once. */
async function fixturePhotos(): Promise<{ file: string; bytes: Buffer }[]> {
  const { readdir } = await import('node:fs/promises');
  await mkdir(FIXTURE_PHOTOS, { recursive: true });
  const names = (await readdir(FIXTURE_PHOTOS))
    .filter((name) => /\.(jpe?g|heic)$/i.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error('no fixture photographs — run `pnpm fixtures` first');
  }
  return Promise.all(
    names.map(async (name) => ({
      file: path.join(FIXTURE_PHOTOS, name),
      bytes: await readFile(path.join(FIXTURE_PHOTOS, name)),
    })),
  );
}

main()
  .catch((error: unknown) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (KEEP) console.log(`Left the working directory at ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
    // The render worker holds a Chromium alive for the process's lifetime.
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  });
