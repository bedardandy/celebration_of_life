/**
 * Rendering the tribute to a file.
 *
 * This is the same composition the family watched in the browser, driven by the
 * same resolved timeline, rendered by a headless Chromium into H.264. Nothing
 * here re-decides a duration or a framing — if it did, the video a family
 * approved and the video a room watches could differ, and there would be no
 * point in any of the rest of it.
 *
 * Three things this file is careful about:
 *
 *  1. **The bundle is built once.** Bundling the composition takes several
 *     seconds; a worker that does it per job spends most of a busy afternoon
 *     running esbuild. It is cached per entry point for the life of the process.
 *  2. **Colour is pinned to bt709.** Remotion's default produces a full-range
 *     file that looks right on the laptop it was made on and washed-out or
 *     green on the projector in the chapel. That failure is invisible until the
 *     worst possible moment.
 *  3. **No audio.** The picture is rendered silent and ffmpeg muxes the sound
 *     in afterwards, because loudness normalisation and fades are ffmpeg's job
 *     and because the side-loaded mode needs a silent file anyway.
 *
 * `@remotion/bundler` and `@remotion/renderer` are imported dynamically so that
 * merely importing `@col/video` — which the web app does, for the Player — does
 * not pull a compiler and a browser driver into a Next.js server bundle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Edl, RenderPreset, ResolvedTimeline } from '@col/schemas';
import { findBrowser, NO_BROWSER_MESSAGE } from './browser';
import { TRIBUTE_COMPOSITION_ID } from './defaults';
import { RENDER_PRESETS, renderPreset, type RenderPresetSpec } from './presets';
import { startAssetServer } from './asset-server';
import { timelineDurationInFrames } from './timeline';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Remotion entry point: the file that calls `registerRoot`. */
export const REMOTION_ENTRY = path.join(here, 'Root.tsx');

export class NoBrowserError extends Error {
  constructor() {
    super(NO_BROWSER_MESSAGE);
    this.name = 'NoBrowserError';
  }
}

/* -------------------------------------------------------------------------- */
/* the bundle cache                                                            */
/* -------------------------------------------------------------------------- */

const bundles = new Map<string, Promise<string>>();

/**
 * Bundle the composition, once per process.
 *
 * The promise itself is cached rather than the result, so two renders starting
 * at the same moment wait on one bundle instead of racing to build two.
 */
export function bundleTribute(entryPoint: string = REMOTION_ENTRY): Promise<string> {
  const cached = bundles.get(entryPoint);
  if (cached) return cached;
  const building = (async () => {
    const { bundle } = await import('@remotion/bundler');
    return bundle({ entryPoint, onProgress: () => {} });
  })().catch((error: unknown) => {
    // A failed bundle must not poison the cache: the next render should try
    // again rather than inherit a rejected promise forever.
    bundles.delete(entryPoint);
    throw error;
  });
  bundles.set(entryPoint, building);
  return building;
}

/** For tests, and for a worker that has been told the composition changed. */
export function clearBundleCache(): void {
  bundles.clear();
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

export type RenderTributeOptions = {
  edl: Edl;
  timeline: ResolvedTimeline;
  /** assetId → absolute path of the photograph on this machine. */
  assetFiles: Record<string, string>;
  preset: RenderPreset;
  /** Where the silent MP4 goes. */
  outputFile: string;
  /** 0..1, called often. Callers throttle their own writes. */
  onProgress?: (progress: number) => void;
  entryPoint?: string;
  signal?: AbortSignal;
  /** Overrides the discovered Chromium. Mostly for tests. */
  browserExecutable?: string;
  concurrency?: number;
};

export type RenderTributeResult = {
  outputFile: string;
  preset: RenderPresetSpec;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSec: number;
  renderMs: number;
};

/**
 * Render one cut of one slideshow at one preset.
 *
 * The preset's frame size is applied by rewriting the EDL's `resolution` before
 * it reaches the composition, which is what `calculateMetadata` reads. Every
 * type size in the composition is a fraction of the frame height, so the same
 * slideshow at 640×360 and at 1920×1080 is the same picture — that is what
 * makes a draft render a useful check of the final one rather than a different
 * video that happens to be smaller.
 */
export async function renderTribute(options: RenderTributeOptions): Promise<RenderTributeResult> {
  const preset = renderPreset(options.preset);
  const startedAt = Date.now();

  const browserExecutable = options.browserExecutable ?? findBrowser()?.executable;
  if (!browserExecutable) throw new NoBrowserError();

  const assets = await startAssetServer(options.assetFiles);

  try {
    const { renderMedia, selectComposition } = await import('@remotion/renderer');
    const serveUrl = await bundleTribute(options.entryPoint ?? REMOTION_ENTRY);

    const inputProps = {
      edl: { ...options.edl, resolution: { w: preset.width, h: preset.height } },
      resolvedTimeline: options.timeline,
      assetUrlMap: assets.urls,
    };

    const browserOptions = {
      browserExecutable,
      // swangle: software rasterisation that behaves the same on a laptop with
      // a GPU and a worker without one. Deterministic beats fast here.
      chromiumOptions: { gl: 'swangle' as const },
    };

    const composition = await selectComposition({
      serveUrl,
      id: TRIBUTE_COMPOSITION_ID,
      inputProps,
      ...browserOptions,
    });

    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      // Pinned rather than defaulted: a full-range (yuvj420p) file is the
      // classic "played fine at home, came out green on the projector" bug.
      colorSpace: 'bt709',
      pixelFormat: 'yuv420p',
      crf: preset.crf,
      x264Preset: preset.x264Preset,
      outputLocation: options.outputFile,
      inputProps,
      ...browserOptions,
      concurrency: options.concurrency ?? preset.concurrency ?? null,
      onProgress: ({ progress }: { progress: number }) => options.onProgress?.(progress),
      ...(options.signal ? { cancelSignal: toCancelSignal(options.signal) } : {}),
    });

    const durationInFrames = timelineDurationInFrames(options.timeline);
    return {
      outputFile: options.outputFile,
      preset,
      width: preset.width,
      height: preset.height,
      fps: composition.fps,
      durationInFrames,
      durationSec: durationInFrames / composition.fps,
      renderMs: Date.now() - startedAt,
    };
  } finally {
    await assets.close();
  }
}

/**
 * Bridge an AbortSignal to Remotion's cancel signal.
 *
 * The worker aborts on shutdown, and a render that ignores that leaves a
 * Chromium behind holding a gigabyte of RAM.
 */
function toCancelSignal(signal: AbortSignal): (cancel: () => void) => void {
  return (cancel: () => void) => {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', () => cancel(), { once: true });
  };
}

/**
 * Re-exported here as well as from the package index so a Node-side caller —
 * the render worker — can learn a preset's frame size without importing the
 * index, which pulls in React components it has no use for.
 */
export { RENDER_PRESETS, renderPreset, type RenderPresetSpec };
