import { z } from 'zod';
import { IdSchema } from './common';

/**
 * The structured record produced for each photo. Analysis is done once, stored,
 * and then a single EDL-generation call reasons over these records instead of
 * re-examining images — that is what keeps sequencing affordable and testable.
 */
export const PhotoAnalysisSchema = z
  .object({
    description: z.string().min(1).max(1000),
    /** Free-form era guess, e.g. "1970s" or "late 1990s". */
    eraGuess: z.string().max(120).optional(),
    settingTags: z.array(z.string().min(1).max(60)),
    peopleCountGuess: z.number().int().min(0).max(100).optional(),
    emotionalTone: z.string().min(1).max(120),
    /** 0..1 — how well this photo carries a full-screen slide. */
    slideSuitability: z.number().min(0).max(1),
    suggestedCaption: z.string().max(300).optional(),
  })
  .strict();
export type PhotoAnalysis = z.infer<typeof PhotoAnalysisSchema>;

/**
 * A batch of photographs, analysed in one call.
 *
 * Batched because a hundred separate calls is a hundred chances to fail
 * halfway, and keyed by `assetId` because the answers have to find their way
 * back to the right rows — the model is shown ids it must echo, not filenames
 * it might paraphrase.
 */
export const PhotoAnalysisEntrySchema = z
  .object({
    assetId: IdSchema,
    analysis: PhotoAnalysisSchema,
  })
  .strict();
export type PhotoAnalysisEntry = z.infer<typeof PhotoAnalysisEntrySchema>;

export const PhotoAnalysisBatchSchema = z
  .object({
    analyses: z.array(PhotoAnalysisEntrySchema),
  })
  .strict();
export type PhotoAnalysisBatch = z.infer<typeof PhotoAnalysisBatchSchema>;
