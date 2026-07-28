/**
 * The micro-render: the smallest real video this product can produce, checked
 * with the same tool a funeral director's laptop effectively uses.
 *
 * "It wouldn't play at the funeral" is the catastrophic failure of this whole
 * product, and it is nearly always a container or pixel-format problem rather
 * than anything visible in a preview. So every CI run bundles the real
 * composition, renders three slides at 320×180, and asks ffprobe whether what
 * came out is H.264, yuv420p, and the length it was asked for. Tiny on purpose:
 * it is a format check, not a quality check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Edl, ResolvedTimeline } from '@col/schemas';
import { EdlSchema, ResolvedTimelineSchema } from '@col/schemas';
import { NO_BROWSER_MESSAGE, findBrowser } from './browser';
import { TRIBUTE_COMPOSITION_ID } from './defaults';
import { timelineDurationInFrames } from './timeline';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, 'Root.tsx');
const FIXTURE_PHOTOS = path.resolve(here, '../../..', 'fixtures/photos');

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;

/* -------------------------------------------------------------------------- */
/* the three-slide fixture                                                     */
/* -------------------------------------------------------------------------- */

const kenBurns = {
  from: { x: 0, y: 0, w: 1, h: 1 },
  to: { x: 0.05, y: 0.04, w: 0.9, h: 0.9 },
  easing: 'easeInOut' as const,
};
const crossfade = { kind: 'crossfade' as const, durationSec: 0.8 };

export const FIXTURE_EDL: Edl = EdlSchema.parse({
  version: 1,
  projectId: 'micro-render',
  fps: FPS,
  resolution: { w: WIDTH, h: HEIGHT },
  audio: { mode: 'sideloaded', startOffsetSec: 0 },
  theme: { id: 'quiet-linen' },
  chapters: [
    { id: 'opening', title: 'Opening', slideIds: ['title'] },
    { id: 'c1', title: 'A life', slideIds: ['photo', 'quote'] },
    { id: 'closing', title: 'Closing', slideIds: ['closing'] },
  ],
  slides: {
    title: {
      kind: 'title',
      text: 'Margaret Anne Doyle',
      subtext: '1938 — 2024',
      durationSec: 2,
      transitionOut: crossfade,
    },
    photo: {
      kind: 'photo',
      assetId: 'asset-1',
      variant: 'render2400',
      durationSec: 3,
      kenBurns,
      caption: { text: 'The garden she kept', position: 'lower-third' },
      transitionOut: { kind: 'fadeThroughBlack', durationSec: 0.8 },
      suitability: 0.8,
      sourceAspect: 0.75,
    },
    quote: {
      kind: 'quote',
      text: 'She always said the garden would outlive her.',
      attribution: 'Her daughter, Anne',
      durationSec: 2,
      transitionOut: crossfade,
    },
    closing: {
      kind: 'closing',
      line1: 'Margaret Anne Doyle',
      line2: '1938 — 2024',
      durationSec: 2,
    },
  },
  cuts: { service: { targetSec: 300 } },
});

/**
 * Written out by hand rather than produced by the timing engine: this test is
 * about the renderer, so the numbers going in must be fixed even if the engine
 * changes its mind about what four photographs deserve.
 */
export const FIXTURE_TIMELINE: ResolvedTimeline = ResolvedTimelineSchema.parse({
  cut: 'family',
  fps: FPS,
  totalSec: 6.6,
  slides: [
    { slideId: 'title', startSec: 0, durationSec: 2, chapterId: 'opening' },
    { slideId: 'photo', startSec: 1.2, durationSec: 3, chapterId: 'c1' },
    { slideId: 'quote', startSec: 3.4, durationSec: 2, chapterId: 'c1' },
    { slideId: 'closing', startSec: 4.6, durationSec: 2, chapterId: 'closing' },
  ],
  chapters: [
    { id: 'opening', title: 'Opening', startSec: 0, slideCount: 1 },
    { id: 'c1', title: 'A life', startSec: 1.2, slideCount: 2 },
    { id: 'closing', title: 'Closing', startSec: 4.6, slideCount: 1 },
  ],
  droppedSlideIds: [],
});

/* -------------------------------------------------------------------------- */

type Probe = {
  streams: { codec_name?: string; pix_fmt?: string; width?: number; height?: number }[];
  format: { duration?: string; format_name?: string };
};

function ffprobe(file: string): Probe {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as Probe;
}

function fixturePhotoDataUrl(): Record<string, string> {
  const file = path.join(FIXTURE_PHOTOS, '01-portrait.jpg');
  if (!existsSync(file)) return {};
  return { 'asset-1': `data:image/jpeg;base64,${readFileSync(file).toString('base64')}` };
}

function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A Chromium already on the machine is preferred, but not required: with none,
 * `browserExecutable: null` lets Remotion fetch its own headless shell. Only if
 * both of those fail does the test skip, and it says so loudly when it does.
 */
const browser = findBrowser();
const ready = hasFfprobe();

if (!ready) {
  process.emitWarning(
    '[micro-render] SKIPPED — ffprobe is not on PATH, so the rendered file cannot be checked. ' +
      'The render smoke test did NOT run on this machine.',
  );
}

/** True for the failures that mean "no browser", rather than "bad video". */
function isBrowserProblem(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /browser|chrom|headless|download|ENOENT|403/i.test(message);
}

let workdir: string;
let output: string;

beforeAll(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'col-render-'));
  output = path.join(workdir, 'micro.mp4');
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!ready)('micro render', () => {
  it('renders three slides to an MP4 a funeral laptop can play', async (ctx) => {
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    const serveUrl = await bundle({ entryPoint: ENTRY, onProgress: () => {} });

    const inputProps = {
      edl: FIXTURE_EDL,
      resolvedTimeline: FIXTURE_TIMELINE,
      // A real photograph, so the Ken Burns path and the blurred backing for
      // a portrait picture are actually exercised. Inlined rather than served
      // from disk because the render browser refuses file:// URLs, exactly as
      // a browser should — in the product these are authorised HTTP URLs.
      assetUrlMap: fixturePhotoDataUrl(),
    };
    const browserOptions = {
      browserExecutable: browser?.executable ?? null,
      chromiumOptions: { gl: 'swangle' as const },
    };

    try {
      const composition = await selectComposition({
        serveUrl,
        id: TRIBUTE_COMPOSITION_ID,
        inputProps,
        ...browserOptions,
      });

      expect(composition.durationInFrames).toBe(timelineDurationInFrames(FIXTURE_TIMELINE));
      expect([composition.width, composition.height]).toEqual([WIDTH, HEIGHT]);

      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        // bt709 rather than the default: a full-range (yuvj420p) file is the
        // classic "plays here, green on the venue projector" bug.
        colorSpace: 'bt709',
        pixelFormat: 'yuv420p',
        outputLocation: output,
        inputProps,
        ...browserOptions,
        concurrency: 1,
        onProgress: () => {},
      });
    } catch (error) {
      // No browser at all, and none obtainable: say so at the top of the run
      // rather than failing a build for a thing the network did.
      if (!isBrowserProblem(error)) throw error;
      process.emitWarning(
        `[micro-render] SKIPPED — ${NO_BROWSER_MESSAGE} (${
          error instanceof Error ? error.message.split('\n')[0] : String(error)
        }) The render smoke test did NOT run on this machine.`,
      );
      ctx.skip();
      return;
    }

    const probe = ffprobe(output);
    const video = probe.streams.find((stream) => stream.codec_name === 'h264');

    expect(video, 'the file must carry an H.264 stream').toBeDefined();
    expect(video?.pix_fmt).toBe('yuv420p');
    expect([video?.width, video?.height]).toEqual([WIDTH, HEIGHT]);
    expect(probe.format.format_name ?? '').toContain('mp4');

    const duration = Number.parseFloat(probe.format.duration ?? '0');
    expect(Math.abs(duration - FIXTURE_TIMELINE.totalSec)).toBeLessThanOrEqual(0.5);
  }, 240_000);
});

describe('finding a browser', () => {
  it('prefers an explicitly configured binary', () => {
    expect(findBrowser({ REMOTION_BROWSER_EXECUTABLE: '/bin/sh' })?.source).toBe('env');
    expect(findBrowser({ REMOTION_BROWSER_EXECUTABLE: '/no/such/browser' })?.source).not.toBe(
      'env',
    );
  });

  it('explains itself when there is nothing to render with', () => {
    expect(NO_BROWSER_MESSAGE).toContain('REMOTION_BROWSER_EXECUTABLE');
  });
});
