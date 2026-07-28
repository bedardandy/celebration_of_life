import { z } from 'zod';
import { IdSchema } from './common';

/**
 * Where an anecdote came from. Provenance matters: the family is the
 * storyteller, AI is only ever a drafting partner, and nothing AI-authored is
 * published without an explicit approval.
 */
export const AnecdoteSourceSchema = z.enum([
  'interview',
  'memory-note',
  'contributor',
  'organizer',
  'ai-draft',
]);
export type AnecdoteSource = z.infer<typeof AnecdoteSourceSchema>;

export const AnecdoteSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1).max(4000),
    source: AnecdoteSourceSchema,
    /** Family-approved. AI drafts start false and never render until true. */
    approved: z.boolean(),
  })
  .strict();
export type Anecdote = z.infer<typeof AnecdoteSchema>;

export const LifeStoryChapterSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(160),
    era: z
      .object({
        from: z.number().int().min(0).max(3000).optional(),
        to: z.number().int().min(0).max(3000).optional(),
      })
      .strict(),
    summary: z.string().max(4000),
    anecdotes: z.array(AnecdoteSchema),
    /** Names of people who belong to this chapter of the story. */
    people: z.array(z.string().min(1)),
    /** What we still don't know — drives the next interview question. */
    openQuestions: z.array(z.string().min(1)),
  })
  .strict();
export type LifeStoryChapter = z.infer<typeof LifeStoryChapterSchema>;

/**
 * The durable interview artifact. Deliberately NOT a transcript: it is the
 * structured state that lets an interview span many sessions, many people and
 * many providers without depending on any vendor's conversation memory.
 */
export const LifeStoryDocumentSchema = z
  .object({
    subject: z
      .object({
        fullName: z.string().min(1).max(200),
        knownAs: z.string().max(200).optional(),
        birthYear: z.number().int().min(1800).max(3000).optional(),
        deathYear: z.number().int().min(1800).max(3000).optional(),
      })
      .strict(),
    structure: z.enum(['chrono', 'thematic', 'mixed']),
    chapters: z.array(LifeStoryChapterSchema),
    themes: z.array(z.string().min(1)),
    /** Plain-language notes on voice: warm, wry, formal, brief. */
    toneNotes: z.string().max(2000),
    /** Chapters/eras with story but no photos — feeds the delegation composer. */
    coveragePhotoGaps: z.array(z.string().min(1)),
  })
  .strict();
export type LifeStoryDocument = z.infer<typeof LifeStoryDocumentSchema>;
