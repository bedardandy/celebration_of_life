import { z } from 'zod';
import { PacingPresetSchema, SlugSchema } from './common';

/**
 * Faith/culture awareness is data, never branching code. Every pack answers the
 * same questions, so the product can say "here is where your slideshow belongs"
 * without the codebase ever containing `if (tradition === 'jewish')`.
 */
export const TraditionPackSchema = z
  .object({
    slug: SlugSchema,
    label: z.string().min(1).max(80),
    pacingPreset: PacingPresetSchema,
    /** One or two plain sentences on the usual shape/timing of the service. */
    serviceTimelineNote: z.string().min(1).max(1200),
    /** Where photo/story media does and does not belong. */
    mediaPlacement: z
      .array(
        z
          .object({
            context: z.string().min(1).max(120),
            guidance: z.string().min(1).max(1200),
          })
          .strict(),
      )
      .min(1),
    musicGuidance: z.array(z.string().min(1).max(600)).min(1),
    /** Adjustments applied to interview prompts for this tradition. */
    interviewAdjustments: z
      .array(
        z
          .object({
            promptSlug: SlugSchema,
            note: z.string().min(1).max(600),
          })
          .strict(),
      )
      .default([]),
    checklistExtras: z.array(z.string().min(1).max(300)).default([]),
    deliveryNotes: z.array(z.string().min(1).max(600)).default([]),
  })
  .strict();
export type TraditionPack = z.infer<typeof TraditionPackSchema>;
