/**
 * The seam for "make this old photograph a little easier to look at".
 *
 * The contract is narrow on purpose: bytes in, bytes out, same dimensions, plus
 * measured numbers describing what changed. That is enough for the two things
 * the product needs — a before/after the family judges for themselves, and an
 * honest sentence about what was done — and small enough that a much heavier
 * restorer (Real-ESRGAN, CodeFormer) can be dropped in behind it without the
 * screens changing at all. docs/photo-enhancement.md describes that path,
 * including why CodeFormer's fidelity weight matters at a funeral.
 *
 * One rule outranks every other consideration in this file: **the person must
 * still look like themselves.** A restorer that invents a plausible face is
 * worse than no restorer, because the family cannot tell it happened and the
 * photograph is the last one they have.
 */

export type EnhanceStats = {
  /** 0..1 spread of the luminance histogram between the 1st and 99th centile. */
  contrastRange: number;
  /** 0..1 mean chroma. Faded prints sit near zero. */
  saturation: number;
  /** Mean luminance, 0..255. */
  meanLuma: number;
  /** Variance of the Laplacian: high frequency, which is detail *and* noise. */
  detail: number;
};

export type EnhanceOutcome = {
  data: Buffer;
  width: number;
  height: number;
  before: EnhanceStats;
  after: EnhanceStats;
  /** What was actually done, in order: 'levels', 'colour', 'sharpen', 'denoise'. */
  steps: string[];
  /** One plain sentence for the screen. Never a claim the numbers do not support. */
  summary: string;
};

export type RestoreOptions = {
  /** Nudge the whole thing gentler or (slightly) stronger. 0..1, default 0.5. */
  strength?: number;
  signal?: AbortSignal;
};

export type RestorerAvailability =
  { available: true; note?: string } | { available: false; reason: string };

export interface Restorer {
  /** 'sharp' | the external command's name. Stored on the row that used it. */
  readonly id: string;
  available(): Promise<RestorerAvailability>;
  restore(input: Buffer, options?: RestoreOptions): Promise<EnhanceOutcome>;
}

/**
 * How the before/after is described. Deliberately hedged: "a little", "gently",
 * and never a promise about the person in the picture.
 */
export function describeEnhancement(before: EnhanceStats, after: EnhanceStats): string {
  const parts: string[] = [];
  if (after.contrastRange - before.contrastRange > 0.03) parts.push('brought the light back');
  if (after.saturation - before.saturation > 0.01) parts.push('warmed the colour a little');
  if (after.detail > before.detail * 1.05) parts.push('sharpened it slightly');
  if (after.detail < before.detail * 0.95) parts.push('softened the speckling');
  if (parts.length === 0) {
    return 'This one was already in good shape, so almost nothing changed.';
  }
  const list =
    parts.length === 1
      ? (parts[0] as string)
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
  return `We ${list}. The original is untouched, and you can go back to it at any time.`;
}
