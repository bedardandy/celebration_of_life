/**
 * Gentle restoration with sharp, and nothing clever.
 *
 * What actually arrives in a memorial is not a corrupted RAW file. It is a
 * phone photograph of a print on a kitchen table: flat, a bit yellow, slightly
 * soft, sometimes speckled. Every one of those has a conservative fix, and
 * conservative is the whole point — families are extremely sensitive to a face
 * that no longer looks like the person, and this runs on the last photograph
 * anyone has of someone. So:
 *
 *  - the histogram is stretched, but only partway towards full range, and only
 *    when it is actually flat;
 *  - colour is warmed only when the picture has almost no colour left;
 *  - sharpening is mild and never applied to an already noisy picture;
 *  - a median filter is used only when speckle is measurably swamping detail;
 *  - geometry is never touched: no rotation, no crop, no resize, no upscaling,
 *    and nothing that could alter the shape of a face.
 *
 * Everything is measured before and after, because the screen shows a family a
 * before and after and the words next to it have to be true.
 */
import sharp from 'sharp';
import { laplacianVariance } from '../quality';
import {
  describeEnhancement,
  type EnhanceOutcome,
  type EnhanceStats,
  type Restorer,
  type RestorerAvailability,
  type RestoreOptions,
} from './restorer';

/** Statistics run on a downscale — cheap, and scale-stable across sizes. */
export const STATS_EDGE = 512;

/** Output quality: this copy may end up on a projector, so above the usual 82. */
export const ENHANCED_JPEG_QUALITY = 88;

/** Below this the histogram is flat enough to be worth stretching. */
export const FLAT_CONTRAST = 0.92;

/** Below this a print has faded far enough that a little colour is a kindness. */
export const FADED_SATURATION = 0.25;

/* -------------------------------------------------------------------------- */
/* measuring                                                                   */
/* -------------------------------------------------------------------------- */

export type Percentiles = { low: number; high: number };

/** The 1st and 99th centile of a luminance histogram, ignoring the tails. */
export function lumaPercentiles(gray: Uint8Array | Buffer, cut = 0.01): Percentiles {
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i += 1) {
    histogram[gray[i] as number] = (histogram[gray[i] as number] as number) + 1;
  }
  const total = gray.length || 1;
  const wanted = Math.max(1, Math.floor(total * cut));

  let seen = 0;
  let low = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += histogram[v] as number;
    if (seen >= wanted) {
      low = v;
      break;
    }
  }
  seen = 0;
  let high = 255;
  for (let v = 255; v >= 0; v -= 1) {
    seen += histogram[v] as number;
    if (seen >= wanted) {
      high = v;
      break;
    }
  }
  return { low, high: Math.max(high, low + 1) };
}

export type Measurement = EnhanceStats & { percentiles: Percentiles; noiseRatio: number };

/**
 * Everything the decisions below need, from one downscaled pass.
 *
 * `noiseRatio` compares detail before and after a 3×3 median: real detail
 * survives a median filter, speckle does not, so a low ratio means most of what
 * looks like detail is noise.
 */
export async function measureForEnhancement(input: Buffer): Promise<Measurement> {
  const base = sharp(input, { failOn: 'none' }).resize({
    width: STATS_EDGE,
    height: STATS_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const { data: rgb, info } = await base
    .clone()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  const gray = new Uint8Array(pixels);
  let saturationSum = 0;
  let lumaSum = 0;

  for (let i = 0; i < pixels; i += 1) {
    const r = rgb[i * 3] as number;
    const g = rgb[i * 3 + 1] as number;
    const b = rgb[i * 3 + 2] as number;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    saturationSum += max === 0 ? 0 : (max - min) / max;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    lumaSum += luma;
    gray[i] = Math.round(luma);
  }

  const detail = laplacianVariance(gray, info.width, info.height);

  const medianGray = await sharp(Buffer.from(gray), {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .median(3)
    .raw()
    .toBuffer();
  const medianDetail = laplacianVariance(medianGray, info.width, info.height);

  const percentiles = lumaPercentiles(gray);

  return {
    contrastRange: round((percentiles.high - percentiles.low) / 255),
    saturation: round(saturationSum / pixels),
    meanLuma: round(lumaSum / pixels, 2),
    detail: round(detail, 2),
    percentiles,
    noiseRatio: detail === 0 ? 1 : round(medianDetail / detail),
  };
}

/* -------------------------------------------------------------------------- */
/* the restorer                                                                */
/* -------------------------------------------------------------------------- */

export type PlannedStep =
  | { kind: 'levels'; slope: number; offset: number }
  | { kind: 'colour'; saturation: number }
  | { kind: 'denoise' }
  | { kind: 'sharpen'; sigma: number };

/**
 * What we would do to this picture, decided from the numbers and nothing else.
 *
 * Separated from doing it so the decisions can be tested against measurements
 * directly, and so a future restorer can reuse the judgement without reusing
 * the pixels.
 */
export function planEnhancement(measurement: Measurement, strength = 0.5): PlannedStep[] {
  const k = clamp(strength, 0, 1);
  const steps: PlannedStep[] = [];

  if (measurement.contrastRange < FLAT_CONTRAST) {
    const { low, high } = measurement.percentiles;
    const full = (251 - 4) / Math.max(1, high - low);
    // Only part of the way to a full stretch, and never more than 1.8×: a
    // photograph that has been pushed hard looks processed, and processed is
    // the one thing a family notices immediately.
    const blend = 0.55 + 0.3 * k;
    const slope = clamp(1 + (full - 1) * blend, 1, 1.8);
    const offset = (4 - slope * low) * blend;
    if (slope > 1.01 || offset < -1)
      steps.push({ kind: 'levels', slope: round(slope, 4), offset: round(offset, 2) });
  }

  if (measurement.saturation < FADED_SATURATION) {
    const lift = (FADED_SATURATION - measurement.saturation) * (0.5 + 0.4 * k);
    const saturation = clamp(1 + lift, 1, 1.2);
    if (saturation > 1.01) steps.push({ kind: 'colour', saturation: round(saturation, 3) });
  }

  const noisy = measurement.noiseRatio < 0.45 && measurement.detail > 150;
  if (noisy) steps.push({ kind: 'denoise' });

  // A noisy picture that has just been median-filtered gets the gentlest touch;
  // an already crisp one is left alone entirely.
  if (measurement.detail < 900) {
    steps.push({ kind: 'sharpen', sigma: noisy ? 0.5 : round(0.6 + 0.3 * k, 3) });
  }

  return steps;
}

export class SharpRestorer implements Restorer {
  readonly id = 'sharp';

  async available(): Promise<RestorerAvailability> {
    return { available: true, note: 'built in — no model, no network' };
  }

  async restore(input: Buffer, options: RestoreOptions = {}): Promise<EnhanceOutcome> {
    const before = await measureForEnhancement(input);
    const steps = planEnhancement(before, options.strength ?? 0.5);

    let pipeline = sharp(input, { failOn: 'none' });
    const names: string[] = [];
    for (const step of steps) {
      options.signal?.throwIfAborted();
      switch (step.kind) {
        case 'levels':
          pipeline = pipeline.linear(step.slope, step.offset);
          names.push('levels');
          break;
        case 'colour':
          pipeline = pipeline.modulate({ saturation: step.saturation });
          names.push('colour');
          break;
        case 'denoise':
          pipeline = pipeline.median(3);
          names.push('denoise');
          break;
        case 'sharpen':
          pipeline = pipeline.sharpen({ sigma: step.sigma });
          names.push('sharpen');
          break;
      }
    }

    const { data, info } = await pipeline
      .jpeg({ quality: ENHANCED_JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const after = await measureForEnhancement(data);

    return {
      data,
      width: info.width,
      height: info.height,
      before: statsOf(before),
      after: statsOf(after),
      steps: names,
      summary: describeEnhancement(statsOf(before), statsOf(after)),
    };
  }
}

function statsOf(measurement: Measurement): EnhanceStats {
  return {
    contrastRange: measurement.contrastRange,
    saturation: measurement.saturation,
    meanLuma: measurement.meanLuma,
    detail: measurement.detail,
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
