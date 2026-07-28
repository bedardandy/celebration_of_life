import { EDL_VERSION, type Edl, type TitleSlide } from '@col/schemas';

/** Delivery of record: 1080p30. The Player preview uses the same numbers. */
export const TRIBUTE_WIDTH = 1920;
export const TRIBUTE_HEIGHT = 1080;
export const TRIBUTE_FPS = 30;
export const TRIBUTE_COMPOSITION_ID = 'Tribute';

/**
 * Placeholder length for the registered composition, so Remotion Studio and
 * `remotion compositions` have something to show before a real EDL exists.
 * Phase 4's timing engine computes the real duration from the EDL.
 */
export const DEFAULT_DURATION_IN_FRAMES = 5 * TRIBUTE_FPS;

/**
 * The smallest EDL that is still a valid one: a single title card. Used as the
 * composition's defaultProps.
 */
export const DEFAULT_EDL: Edl = {
  version: EDL_VERSION,
  projectId: 'default-project',
  fps: TRIBUTE_FPS,
  resolution: { w: TRIBUTE_WIDTH, h: TRIBUTE_HEIGHT },
  audio: { mode: 'sideloaded', startOffsetSec: 0 },
  theme: { id: 'quiet-linen' },
  chapters: [{ id: 'chapter-open', title: 'Opening', slideIds: ['slide-title'] }],
  slides: {
    'slide-title': {
      kind: 'title',
      text: 'In loving memory',
      subtext: 'A tribute',
      durationSec: DEFAULT_DURATION_IN_FRAMES / TRIBUTE_FPS,
      transitionOut: { kind: 'crossfade', durationSec: 1 },
    },
  },
  cuts: { service: { targetSec: 300 } },
};

/**
 * The title card carries the name of the person who died, so the composition
 * reads it from the EDL rather than taking a second, duplicable prop.
 * Chapter order wins; a stray title slide outside any chapter is the fallback.
 */
export function firstTitleSlide(edl: Edl): TitleSlide | undefined {
  for (const chapter of edl.chapters) {
    for (const slideId of chapter.slideIds) {
      const slide = edl.slides[slideId];
      if (slide?.kind === 'title') return slide;
    }
  }
  for (const slide of Object.values(edl.slides)) {
    if (slide.kind === 'title') return slide;
  }
  return undefined;
}
