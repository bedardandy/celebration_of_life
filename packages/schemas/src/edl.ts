import { z } from 'zod';
import {
  AssetVariantKindSchema,
  AudioModeSchema,
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
  });
export type Edl = z.infer<typeof EdlSchema>;
