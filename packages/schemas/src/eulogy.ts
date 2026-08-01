import { z } from 'zod';

/**
 * A eulogy, as data.
 *
 * The person speaking is the author. Everything here is shaped around keeping
 * that true: the draft is a first pass in their voice built from memories they
 * themselves chose, every revision is a new version rather than an overwrite,
 * and any sentence in quotation marks has to be a word-for-word copy of
 * something a real person wrote — or the quotation marks come off.
 */

/** How long a speech is aimed at. The research band for a eulogy is 5–10 minutes. */
export const EULOGY_TARGET_MINUTES = [3, 5, 7, 10] as const;
export type EulogyTargetMinutes = (typeof EULOGY_TARGET_MINUTES)[number];

export const EulogyTargetMinutesSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(10),
]);

/**
 * Tone, in the speaker's terms rather than a writer's. The tradition pack can
 * nudge which of these is offered first; it never removes one.
 */
export const EulogyToneSchema = z.enum(['warm-with-laughter', 'quiet-and-simple', 'faithful']);
export type EulogyTone = z.infer<typeof EulogyToneSchema>;

/** Which of the two things a speech row holds: the speech, or its short form. */
export const EulogyVariantSchema = z.enum(['full', 'graveside']);
export type EulogyVariant = z.infer<typeof EulogyVariantSchema>;

/**
 * A held beat, written into the text itself.
 *
 * It lives in the prose rather than in a separate structure so that the editing
 * box is plain text a person can rearrange freely, and so nothing is lost when
 * they retype a paragraph.
 */
export const PAUSE_MARKER = '[pause]';

/**
 * What one model call returns.
 *
 * Paragraphs, an opening and a closing line, and the ids of the memories it
 * actually used — that last one is checked against the memories the speaker
 * ticked, so a draft can never quietly lean on something they did not choose.
 */
export const EulogyDraftSchema = z
  .object({
    openingLine: z.string().min(1).max(400),
    body: z.array(z.string().min(1).max(4000)).min(1).max(60),
    closingLine: z.string().min(1).max(400),
    usedMemoryIds: z.array(z.string().min(1).max(120)).max(60).default([]),
  })
  .strict();
export type EulogyDraft = z.infer<typeof EulogyDraftSchema>;

/**
 * Everything about a stored version except the words, which live in their own
 * text column so they can be edited without a JSON round trip.
 */
export const EulogyNotesSchema = z
  .object({
    openingLine: z.string().max(400).default(''),
    closingLine: z.string().max(400).default(''),
    /** The memories the speaker ticked at setup. The only ones a draft may use. */
    selectedMemoryIds: z.array(z.string().min(1).max(120)).default([]),
    /** The ones this draft actually leans on. A subset of the above, enforced. */
    usedMemoryIds: z.array(z.string().min(1).max(120)).default([]),
    /** What assembly quietly changed, in words a person could read. */
    warnings: z.array(z.string().min(1).max(400)).default([]),
    wordCount: z.number().int().min(0).max(20000).default(0),
  })
  .strict();
export type EulogyNotes = z.infer<typeof EulogyNotesSchema>;
