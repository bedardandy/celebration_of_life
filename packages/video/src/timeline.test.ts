/**
 * The composition's arithmetic, without a browser.
 *
 * These are the numbers that decide whether a dissolve looks like a dissolve
 * and whether a photograph is stretched: cheap to check here, expensive to
 * notice in a rendered file.
 */
import { describe, expect, it } from 'vitest';
import { EdlSchema, type Edl, type PhotoSlide as PhotoSlideType, type ResolvedTimeline } from '@col/schemas';
import { framesFor, slidePlacements, timelineDurationInFrames } from './timeline';
import { stageOpacity } from './slides/Stage';
import { isPortrait, kenBurnsRect, transformForRect } from './slides/PhotoSlide';
import { cardEntrance } from './slides/Cards';

const kenBurns = {
  from: { x: 0, y: 0, w: 1, h: 1 },
  to: { x: 0.1, y: 0.05, w: 0.8, h: 0.8 },
  easing: 'easeInOut' as const,
};

const edl: Edl = EdlSchema.parse({
  version: 1,
  projectId: 'p',
  fps: 30,
  resolution: { w: 1920, h: 1080 },
  audio: { mode: 'sideloaded', startOffsetSec: 0 },
  theme: { id: 'quiet-linen' },
  chapters: [{ id: 'c1', title: 'One', slideIds: ['a', 'b', 'c'] }],
  slides: {
    a: { kind: 'title', text: 'Margaret', durationSec: 4, transitionOut: { kind: 'crossfade', durationSec: 0.8 } },
    b: {
      kind: 'photo',
      assetId: 'asset-1',
      variant: 'render2400',
      durationSec: 5,
      kenBurns,
      transitionOut: { kind: 'fadeThroughBlack', durationSec: 1 },
    },
    c: { kind: 'closing', line1: 'Margaret', line2: '', durationSec: 6 },
  },
  cuts: { service: { targetSec: 300 } },
});

const timeline: ResolvedTimeline = {
  cut: 'family',
  fps: 30,
  totalSec: 13.2,
  slides: [
    { slideId: 'a', startSec: 0, durationSec: 4, chapterId: 'c1' },
    { slideId: 'b', startSec: 3.2, durationSec: 5, chapterId: 'c1' },
    { slideId: 'c', startSec: 7.2, durationSec: 6, chapterId: 'c1' },
  ],
  chapters: [{ id: 'c1', title: 'One', startSec: 0, slideCount: 3 }],
  droppedSlideIds: [],
};

describe('placing slides on frames', () => {
  it('reads the overlap back out of the timeline rather than recomputing it', () => {
    const placements = slidePlacements(edl, timeline);
    expect(placements.map((p) => p.from)).toEqual([0, 96, 216]);
    expect(placements[1]?.transitionIn).toEqual({ kind: 'crossfade', frames: 24 });
    expect(placements[2]?.transitionIn).toEqual({ kind: 'fadeThroughBlack', frames: 30 });
    expect(placements[0]?.transitionIn.frames).toBe(0);
  });

  it('gives the last slide nothing to fade into', () => {
    const placements = slidePlacements(edl, timeline);
    expect(placements[2]?.transitionOut.frames).toBe(0);
  });

  it('skips a slide the timeline does not mention', () => {
    const partial: ResolvedTimeline = { ...timeline, slides: [timeline.slides[0] as never] };
    expect(slidePlacements(edl, partial)).toHaveLength(1);
  });

  it('never reports a zero-length composition', () => {
    expect(timelineDurationInFrames({ ...timeline, totalSec: 0 })).toBe(1);
    expect(timelineDurationInFrames(timeline)).toBe(396);
    expect(framesFor(1.5, 30)).toBe(45);
  });
});

describe('transitions', () => {
  const base = { durationInFrames: 150 };

  it('fades an arriving slide up across a crossfade', () => {
    const props = {
      ...base,
      transitionIn: { kind: 'crossfade' as const, frames: 24 },
      transitionOut: { kind: 'cut' as const, frames: 0 },
    };
    expect(stageOpacity(0, props)).toBe(0);
    expect(stageOpacity(12, props)).toBeCloseTo(0.5, 2);
    expect(stageOpacity(24, props)).toBe(1);
    expect(stageOpacity(140, props)).toBe(1);
  });

  it('keeps the outgoing slide at full opacity under a crossfade', () => {
    // The arriving slide covers it; dimming both is what smears a dissolve.
    const props = {
      ...base,
      transitionIn: { kind: 'cut' as const, frames: 0 },
      transitionOut: { kind: 'crossfade' as const, frames: 24 },
    };
    expect(stageOpacity(149, props)).toBe(1);
  });

  it('leaves a gap of background in a fade through black', () => {
    const outgoing = {
      ...base,
      transitionIn: { kind: 'cut' as const, frames: 0 },
      transitionOut: { kind: 'fadeThroughBlack' as const, frames: 30 },
    };
    const incoming = {
      ...base,
      transitionIn: { kind: 'fadeThroughBlack' as const, frames: 30 },
      transitionOut: { kind: 'cut' as const, frames: 0 },
    };
    // Halfway through the overlap both are dark: the outgoing has faded out and
    // the incoming has not started.
    expect(stageOpacity(135, outgoing)).toBeCloseTo(0, 5);
    expect(stageOpacity(15, incoming)).toBeCloseTo(0, 5);
    expect(stageOpacity(30, incoming)).toBe(1);
  });

  it('does nothing at all on a cut', () => {
    const props = {
      ...base,
      transitionIn: { kind: 'cut' as const, frames: 0 },
      transitionOut: { kind: 'cut' as const, frames: 0 },
    };
    expect(stageOpacity(0, props)).toBe(1);
    expect(stageOpacity(149, props)).toBe(1);
  });
});

describe('ken burns', () => {
  const slide = edl.slides['b'] as PhotoSlideType;

  it('starts at the from rect and ends at the to rect', () => {
    expect(kenBurnsRect(slide, 0, 150)).toEqual(kenBurns.from);
    const end = kenBurnsRect(slide, 149, 150);
    expect(end.w).toBeCloseTo(kenBurns.to.w, 5);
    expect(end.x).toBeCloseTo(kenBurns.to.x, 5);
  });

  it('moves monotonically, and only ever inward here', () => {
    let previous = 1.1;
    for (let frame = 0; frame <= 150; frame += 10) {
      const { w } = kenBurnsRect(slide, frame, 150);
      expect(w).toBeLessThanOrEqual(previous + 1e-9);
      previous = w;
    }
  });

  it('scales from the width alone, so nothing is stretched', () => {
    const transform = transformForRect({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 1920, 1080);
    expect(transform).toContain('scale(2.00000)');
    // Rect centre (0.35, 0.4) has to travel to the frame centre.
    expect(transform).toContain(`translate(${(2 * 0.15 * 1920).toFixed(3)}px`);
    expect(transform).toContain(`${(2 * 0.1 * 1080).toFixed(3)}px)`);
  });

  it('gives a portrait photograph a blurred backing and leaves landscape alone', () => {
    expect(isPortrait({ ...slide, sourceAspect: 0.75 }, 16 / 9)).toBe(true);
    expect(isPortrait({ ...slide, sourceAspect: 1.5 }, 16 / 9)).toBe(true);
    expect(isPortrait({ ...slide, sourceAspect: 1.78 }, 16 / 9)).toBe(false);
    // Unknown shape is treated as landscape: cover, no blurred bars.
    expect(isPortrait(slide, 16 / 9)).toBe(false);
  });
});

describe('cards', () => {
  it('arrives with one slow fade and a small lift, then holds', () => {
    expect(cardEntrance(0, 30)).toEqual({ opacity: 0, lift: 14 });
    const settled = cardEntrance(120, 30);
    expect(settled.opacity).toBe(1);
    expect(settled.lift).toBe(0);
  });
});
