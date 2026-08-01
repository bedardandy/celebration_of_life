/**
 * Which restorer this machine has, and what an enhanced copy is called.
 *
 * The built-in sharp restorer is always available, so unlike face grouping this
 * feature never disappears — but it is still opt-in per photograph, because
 * "we improved your mother's photograph" is not a thing to do to somebody
 * without asking.
 */
import sharp from 'sharp';
import { SharpRestorer } from './sharp-restorer';
import { externalRestorerFromEnv } from './external-restorer';
import type { EnhanceOutcome, Restorer, RestoreOptions } from './restorer';

export * from './restorer';
export * from './sharp-restorer';
export * from './external-restorer';

/** The variant an accepted enhancement is served from. */
export const ENHANCED_VARIANT = 'enhanced2400' as const;

/** Longest edge of the enhanced copy: the same as the render variant. */
export const ENHANCED_EDGE = 2400;

/** The badge on a photograph the family chose the improved copy of. */
export const ENHANCED_BADGE = 'Gently restored';

export function resolveRestorer(env: NodeJS.ProcessEnv = process.env): Restorer {
  return externalRestorerFromEnv(env) ?? new SharpRestorer();
}

/**
 * The whole job, as a pure function of bytes: take an original, produce the
 * enhanced copy at render size.
 *
 * Downscaling happens *first* and only ever downwards, so the restorer works at
 * the size the family will actually see and no photograph is ever enlarged into
 * detail it never had.
 */
export async function makeEnhancedCopy(
  original: Buffer,
  restorer: Restorer = new SharpRestorer(),
  options: RestoreOptions & { edge?: number } = {},
): Promise<EnhanceOutcome> {
  const sized = await sharp(original, { failOn: 'none' })
    .rotate()
    .resize({
      width: options.edge ?? ENHANCED_EDGE,
      height: options.edge ?? ENHANCED_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 95 })
    .toBuffer();
  return restorer.restore(sized, options);
}
