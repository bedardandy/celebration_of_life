import { z } from 'zod';
import {
  AssetVariantKindSchema,
  AudioModeSchema,
  CutNameSchema,
  EasingSchema,
  IdSchema,
  RectSchema,
  TransitionSchema,
} from './common';

/**
 * Beat grid for a bundled cleared track. Precomputed at library build time so
 * the timing engine can snap transitions to musical phrase boundaries without
 * doing DSP at request time.
 *  - beats:   seconds from track start for every beat
 *  - phrases: seconds from track start for phrase boundaries (usually every 8/16 beats)
 */
export const BeatGridSchema = z
  .object({
    bpm: z.number().gt(0).max(400),
    beats: z.array(z.number().min(0)),
    phrases: z.array(z.number().min(0)),
  })
  .strict();
export type BeatGrid = z.infer<typeof BeatGridSchema>;

export const EdlAudioSchema = z
  .object({
    /**
     * cleared    = a licensed/PD track is baked into the MP4 (shareable)
     * sideloaded = the video is silent and timed to a song the venue plays live
     */
    mode: AudioModeSchema,
    trackId: IdSchema.optional(),
    startOffsetSec: z.number().min(0).default(0),
    beatGrid: BeatGridSchema.optional(),
  })
  .strict();
export type EdlAudio = z.infer<typeof EdlAudioSchema>;

export const EdlThemeSchema = z
  .object({
    id: z.string().min(1),
    palette: z.array(z.string().min(1)).optional(),
    fontPair: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  })
  .strict();
export type EdlTheme = z.infer<typeof EdlThemeSchema>;

export const KenBurnsSchema = z
  .object({
    from: RectSchema,
    to: RectSchema,
    easing: EasingSchema,
  })
  .strict();
export type KenBurns = z.infer<typeof KenBurnsSchema>;

export const CaptionSchema = z
  .object({
    text: z.string().min(1).max(300),
    position: z.enum(['top', 'bottom', 'lower-third']),
  })
  .strict();
export type Caption = z.infer<typeof CaptionSchema>;

/** 3–7s is the researched comfortable band for a tribute slideshow. */
const DurationSecSchema = z.number().gt(0).max(60);

export const TitleSlideSchema = z
  .object({
    kind: z.literal('title'),
    text: z.string().min(1).max(200),
    subtext: z.string().max(200).optional(),
    durationSec: DurationSecSchema,
    transitionOut: TransitionSchema,
  })
  .strict();

export const PhotoSlideSchema = z
  .object({
    kind: z.literal('photo'),
    assetId: IdSchema,
    variant: AssetVariantKindSchema,
    durationSec: DurationSecSchema,
    kenBurns: KenBurnsSchema,
    caption: CaptionSchema.optional(),
    transitionOut: TransitionSchema,
    /**
     * 0..1, copied from the photo's analysis at assembly time. Carried on the
     * slide so the service cut can be projected from the EDL alone — a cut that
     * needed a database round-trip could not be recomputed in the browser.
     */
    suitability: z.number().min(0).max(1).optional(),
    /**
     * Source width ÷ height. Lets the composition decide, deterministically and
     * without measuring pixels, whether a photo needs the blurred backing that
     * stops a portrait picture from sitting in two black bars.
     */
    sourceAspect: z.number().gt(0).max(100).optional(),
  })
  .strict();

export const QuoteSlideSchema = z
  .object({
    kind: z.literal('quote'),
    text: z.string().min(1).max(600),
    attribution: z.string().min(1).max(120),
    durationSec: DurationSecSchema,
    transitionOut: TransitionSchema,
  })
  .strict();

export const ClosingSlideSchema = z
  .object({
    kind: z.literal('closing'),
    line1: z.string().min(1).max(200),
    line2: z.string().max(200),
    durationSec: DurationSecSchema,
  })
  .strict();

export const SlideSchema = z.discriminatedUnion('kind', [
  TitleSlideSchema,
  PhotoSlideSchema,
  QuoteSlideSchema,
  ClosingSlideSchema,
]);
export type Slide = z.infer<typeof SlideSchema>;
export type TitleSlide = z.infer<typeof TitleSlideSchema>;
export type PhotoSlide = z.infer<typeof PhotoSlideSchema>;
export type QuoteSlide = z.infer<typeof QuoteSlideSchema>;
export type ClosingSlide = z.infer<typeof ClosingSlideSchema>;

export const EdlChapterSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(120),
    slideIds: z.array(IdSchema),
  })
  .strict();
export type EdlChapter = z.infer<typeof EdlChapterSchema>;

/**
 * Two cuts are a first-class feature, not an export option: a tight cut for the
 * service and a longer one for the family. The service cut is a *projection* of
 * the same slide set, so it never diverges.
 */
export const EdlCutsSchema = z
  .object({
    service: z
      .object({
        targetSec: z.number().gt(0),
        includeSlideIds: z.array(IdSchema).optional(),
      })
      .strict(),
    family: z
      .object({
        targetSec: z.number().gt(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EdlCuts = z.infer<typeof EdlCutsSchema>;

export const EDL_VERSION = 1 as const;

export const EdlSchema = z
  .object({
    version: z.literal(EDL_VERSION),
    projectId: IdSchema,
    fps: z.number().int().min(1).max(120),
    resolution: z
      .object({
        w: z.number().int().min(16).max(7680),
        h: z.number().int().min(16).max(4320),
      })
      .strict(),
    audio: EdlAudioSchema,
    theme: EdlThemeSchema,
    chapters: z.array(EdlChapterSchema),
    /** Keyed by slide id. Chapters reference these ids in order. */
    slides: z.record(IdSchema, SlideSchema),
    cuts: EdlCutsSchema,
    /**
     * Slides the family took out on the preview screen.
     *
     * They stay in `slides` and in their chapter, at their original position,
     * and are simply skipped when a cut is resolved. That is what makes "put it
     * back" exact rather than approximate — nothing about where the slide
     * belonged has been thrown away.
     */
    omittedSlideIds: z.array(IdSchema).default([]),
  })
  .strict()
  .superRefine((edl, ctx) => {
    for (const [ci, chapter] of edl.chapters.entries()) {
      for (const [si, slideId] of chapter.slideIds.entries()) {
        if (!(slideId in edl.slides)) {
          ctx.addIssue({
            code: 'custom',
            path: ['chapters', ci, 'slideIds', si],
            message: `chapter "${chapter.title}" references unknown slide id "${slideId}"`,
          });
        }
      }
    }
    for (const [si, slideId] of (edl.cuts.service.includeSlideIds ?? []).entries()) {
      if (!(slideId in edl.slides)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cuts', 'service', 'includeSlideIds', si],
          message: `service cut references unknown slide id "${slideId}"`,
        });
      }
    }
    for (const [si, slideId] of edl.omittedSlideIds.entries()) {
      if (!(slideId in edl.slides)) {
        ctx.addIssue({
          code: 'custom',
          path: ['omittedSlideIds', si],
          message: `omitted slide id "${slideId}" is not a slide`,
        });
      }
    }
  });
export type Edl = z.infer<typeof EdlSchema>;

/* -------------------------------------------------------------------------- */
/* resolved timeline                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the timing engine produces and what actually gets played.
 *
 * The EDL says what the slideshow *is*; a resolved timeline says where every
 * slide lands on the clock for one particular cut. The browser preview and the
 * renderer are handed the same resolved timeline, which is the only reason the
 * two can be frame-identical.
 */
export const ResolvedSlideSchema = z
  .object({
    slideId: IdSchema,
    startSec: z.number().min(0),
    durationSec: z.number().gt(0),
    /** Chapter this slide belongs to, so the preview can offer jump links. */
    chapterId: IdSchema.optional(),
  })
  .strict();
export type ResolvedSlide = z.infer<typeof ResolvedSlideSchema>;

export const ResolvedChapterSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(120),
    startSec: z.number().min(0),
    slideCount: z.number().int().min(0),
  })
  .strict();
export type ResolvedChapter = z.infer<typeof ResolvedChapterSchema>;

export const ResolvedTimelineSchema = z
  .object({
    cut: CutNameSchema,
    fps: z.number().int().min(1).max(120),
    /** Wall-clock length including transition overlap. */
    totalSec: z.number().min(0),
    slides: z.array(ResolvedSlideSchema),
    chapters: z.array(ResolvedChapterSchema),
    /** Slides this cut left out, for the "shorter for the service" note. */
    droppedSlideIds: z.array(IdSchema),
  })
  .strict();
export type ResolvedTimeline = z.infer<typeof ResolvedTimelineSchema>;

/* -------------------------------------------------------------------------- */
/* EDL proposal (what the model is allowed to decide)                          */
/* -------------------------------------------------------------------------- */

/**
 * Where the eye should be. The model names a focal region in words; the code
 * turns each word into concrete from/to rectangles, so the arithmetic of a Ken
 * Burns move is never something a language model got to invent.
 */
export const KenBurnsHintSchema = z.enum(['face-left', 'face-right', 'center', 'wide']);
export type KenBurnsHint = z.infer<typeof KenBurnsHintSchema>;

export const EdlProposalPhotoSchema = z
  .object({
    assetId: IdSchema,
    kenBurns: KenBurnsHintSchema,
    /** Short factual line. Optional, and the family can always edit it. */
    caption: z.string().max(300).optional(),
  })
  .strict();
export type EdlProposalPhoto = z.infer<typeof EdlProposalPhotoSchema>;

/**
 * A memory on screen in the family's own words.
 *
 * `text` must be a verbatim copy of an approved anecdote or memory note —
 * assembly checks it against the list it supplied and drops anything the model
 * rewrote. A memorial is not the place to discover that an AI improved a
 * sentence someone's daughter wrote.
 */
export const EdlProposalQuoteSchema = z
  .object({
    text: z.string().min(1).max(600),
    attribution: z.string().min(1).max(120),
    /** Where in the chapter it lands: before the photos, or after them. */
    placement: z.enum(['before', 'after']).default('before'),
  })
  .strict();
export type EdlProposalQuote = z.infer<typeof EdlProposalQuoteSchema>;

export const EdlProposalChapterSchema = z
  .object({
    title: z.string().min(1).max(120),
    photos: z.array(EdlProposalPhotoSchema).max(400),
    quotes: z.array(EdlProposalQuoteSchema).max(4).default([]),
  })
  .strict();
export type EdlProposalChapter = z.infer<typeof EdlProposalChapterSchema>;

export const EdlProposalSchema = z
  .object({
    /** The opening card: usually the name, and the years underneath. */
    openingTitle: z
      .object({
        text: z.string().min(1).max(200),
        subtext: z.string().max(200).optional(),
      })
      .strict(),
    chapters: z.array(EdlProposalChapterSchema).min(1).max(12),
    closing: z
      .object({
        line1: z.string().min(1).max(200),
        /** One quiet line. Years, or "Thank you for being here." */
        line2: z.string().max(200).default(''),
      })
      .strict(),
  })
  .strict();
export type EdlProposal = z.infer<typeof EdlProposalSchema>;
