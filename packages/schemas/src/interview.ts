import { z } from 'zod';
import { IdSchema, SlugSchema } from './common';
import { AnecdoteSourceSchema } from './life-story';

/**
 * What one turn of the guided interview produces.
 *
 * The interview does not persist a transcript. It persists *this*: a next
 * question, the facts we heard, and a patch to the durable LifeStoryDocument.
 * That is what lets an interview span several evenings, several relatives and
 * several AI providers without depending on any vendor's conversation memory —
 * and it is what makes the whole thing testable, because a patch is a value.
 */

export const InterviewFactKindSchema = z.enum([
  'person',
  'place',
  'era',
  'passion',
  'trait',
  'event',
]);
export type InterviewFactKind = z.infer<typeof InterviewFactKindSchema>;

export const InterviewFactSchema = z
  .object({
    kind: InterviewFactKindSchema,
    text: z.string().min(1).max(400),
  })
  .strict();
export type InterviewFact = z.infer<typeof InterviewFactSchema>;

/**
 * A chapter, partially. Fields left out are left alone — an interview turn
 * about a garden must not blank out what we already know about a childhood.
 */
export const ChapterPatchSchema = z
  .object({
    /** Kebab-case is conventional but not enforced; ids also come from newId(). */
    id: IdSchema,
    title: z.string().min(1).max(160).optional(),
    era: z
      .object({
        from: z.number().int().min(0).max(3000).optional(),
        to: z.number().int().min(0).max(3000).optional(),
      })
      .strict()
      .optional(),
    summary: z.string().max(4000).optional(),
    people: z.array(z.string().min(1)).optional(),
    openQuestions: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ChapterPatch = z.infer<typeof ChapterPatchSchema>;

/** A story to add. It arrives unapproved; a person decides if it is true. */
export const AnecdoteAddSchema = z
  .object({
    chapterId: IdSchema.optional(),
    text: z.string().min(1).max(4000),
    source: AnecdoteSourceSchema.default('interview'),
  })
  .strict();
export type AnecdoteAdd = z.infer<typeof AnecdoteAddSchema>;

/**
 * Additive only, deliberately. There is no "remove" verb: the interview can
 * never delete something a family has already approved.
 */
export const DocPatchSchema = z
  .object({
    chapterUpserts: z.array(ChapterPatchSchema).default([]),
    themeAdds: z.array(z.string().min(1).max(160)).default([]),
    openQuestionAdds: z.array(z.string().min(1).max(400)).default([]),
    anecdoteAdds: z.array(AnecdoteAddSchema).default([]),
  })
  .strict();
export type DocPatch = z.infer<typeof DocPatchSchema>;

export const InterviewQuestionSchema = z
  .object({
    text: z.string().min(1).max(600),
    /** Which prompt from the spine this covers, when it maps to one. */
    promptSlug: SlugSchema.optional(),
  })
  .strict();
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

export const InterviewCoverageSchema = z
  .object({
    /** Is there enough here to draft from? Never used to end the interview. */
    sufficientForDraft: z.boolean(),
    note: z.string().max(600).optional(),
  })
  .strict();
export type InterviewCoverage = z.infer<typeof InterviewCoverageSchema>;

export const InterviewTurnSchema = z
  .object({
    nextQuestion: InterviewQuestionSchema,
    extractedFacts: z.array(InterviewFactSchema).default([]),
    docPatch: DocPatchSchema,
    coverage: InterviewCoverageSchema,
  })
  .strict();
export type InterviewTurnResult = z.infer<typeof InterviewTurnSchema>;

export const EMPTY_DOC_PATCH: DocPatch = {
  chapterUpserts: [],
  themeAdds: [],
  openQuestionAdds: [],
  anecdoteAdds: [],
};
