import { z } from 'zod';

/** Every id in the system is a UUIDv7 string (sortable, Postgres-portable). */
export const IdSchema = z.string().min(1).max(64);

/** Slug used for tradition packs, prompts, themes, tracks. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

/** Epoch milliseconds. Stored as an integer column in both SQLite and Postgres. */
export const EpochMsSchema = z.number().int();

/**
 * Normalised rectangle in 0..1 space, relative to the frame.
 * Used for Ken Burns start/end framing so the EDL is resolution-independent.
 */
export const RectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .strict();
export type Rect = z.infer<typeof RectSchema>;

export const EasingSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);
export type Easing = z.infer<typeof EasingSchema>;

export const TransitionKindSchema = z.enum(['crossfade', 'fadeThroughBlack', 'cut']);
export type TransitionKind = z.infer<typeof TransitionKindSchema>;

export const TransitionSchema = z
  .object({
    kind: TransitionKindSchema,
    durationSec: z.number().min(0).max(5),
  })
  .strict();
export type Transition = z.infer<typeof TransitionSchema>;

/**
 * Rendered derivative of an original upload.
 *
 * `enhanced2400` is the opt-in gently-restored copy. It sits beside
 * `render2400` rather than replacing it, because the original and the plain
 * derivative must survive a family changing their mind.
 */
export const AssetVariantKindSchema = z.enum([
  'thumb320',
  'web1600',
  'render2400',
  'enhanced2400',
  'original',
]);
export type AssetVariantKind = z.infer<typeof AssetVariantKindSchema>;

export const PacingPresetSchema = z.enum(['urgent24h', 'days3to7', 'memorial-cycle', 'flexible']);
export type PacingPreset = z.infer<typeof PacingPresetSchema>;

export const AudioModeSchema = z.enum(['cleared', 'sideloaded']);
export type AudioMode = z.infer<typeof AudioModeSchema>;

export const RenderPresetSchema = z.enum(['draft360', 'final1080', 'backup720']);
export type RenderPreset = z.infer<typeof RenderPresetSchema>;

export const CutNameSchema = z.enum(['service', 'family']);
export type CutName = z.infer<typeof CutNameSchema>;
