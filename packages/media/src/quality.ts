/**
 * How usable a photo is, as a number between 0 and 1.
 *
 * This score never removes anything. A blurry photo of someone's mother is
 * still the only photo of that moment, and the product's promise is that we
 * flag and let the family decide — "a little blurry, still lovely on screen for
 * a moment or two". What the score is for is ordering: which frame of a burst
 * to show as the group's card, and which slides to drop first when a
 * five-minute cut has to lose something.
 *
 * Two measurements, both cheap and both explainable:
 *  - variance of the Laplacian: the classic focus measure. Edges make it big;
 *    a smeared photo has almost none.
 *  - clipping: how much of the frame is pinned at pure black or pure white,
 *    which is what a flash indoors or a backlit garden shot does.
 */
import sharp from 'sharp';

/** Analysis runs on a downscale — focus is scale-dependent, so fix the scale. */
export const ANALYSIS_EDGE = 512;

/**
 * Laplacian variance at which a photo is "half sharp" in the soft curve below.
 * Fixture sharp photos land near 350 (score ≈ 0.85); the deliberately blurred
 * fixture lands near 2 (score ≈ 0.03).
 */
export const SHARPNESS_HALF_POINT = 60;

/** Below this, the grid shows a gentle "a little blurry" badge. Never hides. */
export const BLURRY_SCORE_THRESHOLD = 0.25;

/** Clipping below this is normal photography, not a problem worth mentioning. */
export const CLIPPING_TOLERANCE = 0.15;

export type QualityMeasurement = {
  /** 0..1, higher is sharper. */
  blurScore: number;
  /** 0..1 overall usability: sharpness, moderated by exposure. */
  qualityScore: number;
  /** Share of pixels pinned at black or white. */
  clippedFraction: number;
  /** Mean luminance 0..255. Useful for "this came out very dark" copy later. */
  meanLuma: number;
  /** Raw variance of the Laplacian, before normalisation. Kept for tuning. */
  laplacianVariance: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Variance of the 4-neighbour Laplacian, computed in JavaScript rather than
 * through sharp's `convolve` because convolve clamps to 8-bit and throws away
 * every negative response — which is half the signal.
 */
export function laplacianVariance(
  gray: Uint8Array | Buffer,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const response =
        (gray[i - width] as number) +
        (gray[i + width] as number) +
        (gray[i - 1] as number) +
        (gray[i + 1] as number) -
        4 * (gray[i] as number);
      sum += response;
      sumSq += response * response;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Soft, bounded, monotonic: no cliff edge where one photo is fine and the next is not. */
export function sharpnessScore(
  variance: number,
  halfPoint: number = SHARPNESS_HALF_POINT,
): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0;
  return clamp01(variance / (variance + halfPoint));
}

export function measureQualityFromGray(
  gray: Uint8Array | Buffer,
  width: number,
  height: number,
): QualityMeasurement {
  const variance = laplacianVariance(gray, width, height);
  const blurScore = sharpnessScore(variance);

  let dark = 0;
  let bright = 0;
  let total = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i] as number;
    total += v;
    if (v <= 2) dark += 1;
    else if (v >= 253) bright += 1;
  }
  const pixels = gray.length || 1;
  const clippedFraction = (dark + bright) / pixels;
  const meanLuma = total / pixels;

  // Exposure only ever moderates the sharpness score; it cannot rescue a
  // smeared photo, and it should not condemn a contrasty one.
  const exposurePenalty = clamp01((clippedFraction - CLIPPING_TOLERANCE) / 0.35);
  const qualityScore = clamp01(blurScore * (1 - 0.6 * exposurePenalty));

  return {
    blurScore: round(blurScore),
    qualityScore: round(qualityScore),
    clippedFraction: round(clippedFraction),
    meanLuma: round(meanLuma, 2),
    laplacianVariance: round(variance, 2),
  };
}

/** Measure an encoded image. Auto-rotates first, so orientation cannot skew it. */
export async function measureQuality(input: Buffer): Promise<QualityMeasurement> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize({ width: ANALYSIS_EDGE, height: ANALYSIS_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return measureQualityFromGray(data, info.width, info.height);
}

export function isBlurry(
  blurScore: number | null | undefined,
  threshold: number = BLURRY_SCORE_THRESHOLD,
): boolean {
  return typeof blurScore === 'number' && blurScore < threshold;
}

/** The badge wording. Kept beside the threshold so the two never drift apart. */
export const BLURRY_BADGE = 'A little blurry — still lovely on screen for a moment or two.';
