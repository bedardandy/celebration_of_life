import { z } from 'zod';

/**
 * The order of service, as data.
 *
 * A printed program is the one thing from a funeral that people keep. It goes
 * in a drawer, and it comes out again years later. So the document is plain and
 * whole: a cover, an order, a short life sketch, a reading, and a thank you —
 * nothing that depends on a screen, and nothing a print shop cannot set.
 */

/** One line of the order of service: what happens, and who is doing it. */
export const OrderOfServiceItemSchema = z
  .object({
    item: z.string().min(1).max(120),
    /** "Reading by her granddaughter, Nell" — optional, and often the best part. */
    note: z.string().min(1).max(300).optional(),
  })
  .strict();
export type OrderOfServiceItem = z.infer<typeof OrderOfServiceItemSchema>;

/**
 * A reading a family might use.
 *
 * `text` is only ever present for material that is unambiguously in the public
 * domain — old translations, old poems, old prayers. Anything still in
 * copyright is named and sourced so a family can find it, and never reproduced
 * here.
 */
export const ProgramReadingSchema = z
  .object({
    title: z.string().min(1).max(160),
    /** Public domain only. Absent means "we can name it, not print it". */
    text: z.string().min(1).max(4000).optional(),
    /** Where it comes from: "Psalm 23, King James Version (public domain)". */
    source: z.string().min(1).max(300),
  })
  .strict();
export type ProgramReading = z.infer<typeof ProgramReadingSchema>;

/**
 * The working document behind the printed program. Versioned append-only, like
 * the life story, so an organiser can always get back the wording they had an
 * hour ago.
 */
export const ProgramDocumentSchema = z
  .object({
    /** An approved photograph, portrait-cropped by the print layout. */
    coverAssetId: z.string().min(1).max(120).optional(),
    /** "In Loving Memory" by default; some families want their own words. */
    coverLine: z.string().max(120).default('In Loving Memory'),
    fullName: z.string().min(1).max(200),
    /** "1936 — 2024", already formatted, because a dash matters on a cover. */
    lifeDates: z.string().max(120).default(''),
    /** Where and when, in one line under the dates. */
    serviceLine: z.string().max(300).default(''),
    orderOfService: z.array(OrderOfServiceItemSchema).max(40).default([]),
    /** 150–250 words. AI may draft it; the family always edits it. */
    lifeSketch: z.string().max(6000).default(''),
    reading: ProgramReadingSchema.optional(),
    acknowledgments: z.string().max(2000).default(''),
    /** The back page, when a family wants a last quiet line there. */
    backNote: z.string().max(600).default(''),
  })
  .strict();
export type ProgramDocument = z.infer<typeof ProgramDocumentSchema>;

/** What the life-sketch model call returns: prose, in paragraphs, nothing else. */
export const LifeSketchDraftSchema = z
  .object({
    paragraphs: z.array(z.string().min(1).max(2000)).min(1).max(5),
  })
  .strict();
export type LifeSketchDraft = z.infer<typeof LifeSketchDraftSchema>;
