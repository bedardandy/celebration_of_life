/**
 * The timing engine is the one piece of this product that has to be right in a
 * way nobody can eyeball. A slideshow that runs ninety seconds long during a
 * service, or a photograph that flashes past in a second and a half, is not a
 * bug anyone gets to fix afterwards — so the band, the fit, the snapping and
 * the cut projection are all pinned down here.
 */
import { describe, expect, it } from 'vitest';
import { EdlSchema, type BeatGrid, type Edl, type Slide } from '@col/schemas';
import {
  CROSSFADE_SEC,
  PHOTO_MAX_SEC,
  PHOTO_MIN_SEC,
  QUOTE_SEC,
  SNAP_TOLERANCE_SEC,
  TITLE_SEC,
  assignTimings,
  clampDuration,
  describeLength,
  durationInFrames,
  floorDuration,
  overlapFor,
  projectCut,
  snapBoundary,
  totalWithOverlap,
  withFittedDurations,
  type TimingSlide,
} from './timing';

const crossfade = { kind: 'crossfade' as const, durationSec: CROSSFADE_SEC };
const cut = { kind: 'cut' as const, durationSec: 0 };

function photos(count: number, durationSec?: number, chapterId = 'c1'): TimingSlide[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${chapterId}-s${i + 1}`,
    kind: 'photo' as const,
    ...(durationSec === undefined ? {} : { durationSec }),
    transitionOut: crossfade,
    chapterId,
  }));
}

/* -------------------------------------------------------------------------- */

describe('the band', () => {
  it('holds a photograph between three and seven seconds, whatever it is asked for', () => {
    expect(clampDuration('photo', 0.2)).toBe(PHOTO_MIN_SEC);
    expect(clampDuration('photo', 90)).toBe(PHOTO_MAX_SEC);
    expect(clampDuration('photo', 5)).toBe(5);
    expect(clampDuration('photo', undefined)).toBeGreaterThanOrEqual(PHOTO_MIN_SEC);
    expect(clampDuration('photo', undefined)).toBeLessThanOrEqual(PHOTO_MAX_SEC);
  });

  it('gives cards a fixed hold, because people are reading them', () => {
    expect(clampDuration('title', 30)).toBe(TITLE_SEC);
    expect(clampDuration('quote', 0.5)).toBe(QUOTE_SEC);
  });

  it('never leaves the band even when the target is impossible', () => {
    const wanted = assignTimings(photos(10), { targetSec: 4 });
    for (const slide of wanted.slides) expect(slide.durationSec).toBe(PHOTO_MIN_SEC);

    const stretched = assignTimings(photos(10), { targetSec: 6000 });
    for (const slide of stretched.slides) expect(slide.durationSec).toBe(PHOTO_MAX_SEC);
  });
});

describe('transition overlap', () => {
  it('makes the whole shorter than the sum of its slides', () => {
    const slides = photos(4, 5);
    const timing = assignTimings(slides);
    const sum = timing.slides.reduce((n, s) => n + s.durationSec, 0);
    expect(sum).toBeCloseTo(20, 5);
    // three crossfades of 0.8s are shared between neighbours
    expect(timing.totalSec).toBeCloseTo(20 - 3 * CROSSFADE_SEC, 5);
  });

  it('starts the next slide before the last one has gone', () => {
    const timing = assignTimings(photos(3, 5));
    const [first, second] = timing.slides;
    expect(second?.startSec).toBeCloseTo((first?.startSec ?? 0) + 5 - CROSSFADE_SEC, 5);
  });

  it('a hard cut overlaps nothing', () => {
    const slides = photos(3, 5).map((slide) => ({ ...slide, transitionOut: cut }));
    expect(assignTimings(slides).totalSec).toBeCloseTo(15, 5);
    expect(overlapFor(cut, 5, 5)).toBe(0);
  });

  it('never dissolves for longer than half of either slide it joins', () => {
    expect(overlapFor({ kind: 'crossfade', durationSec: 4 }, 3, 6)).toBe(1.5);
  });
});

describe('fitting to a target', () => {
  const target = 300;

  it('lands within five percent of the length asked for', () => {
    const slides = [
      { id: 'title', kind: 'title' as const, transitionOut: crossfade, chapterId: 'open' },
      ...photos(60),
      { id: 'closing', kind: 'closing' as const, chapterId: 'close' },
    ];
    const timing = assignTimings(slides, { targetSec: target });
    expect(Math.abs(timing.totalSec - target) / target).toBeLessThan(0.05);
  });

  it('stretches a short slideshow and squeezes a long one', () => {
    const short = assignTimings(photos(40), { targetSec: 240 });
    const long = assignTimings(photos(90), { targetSec: 240 });
    expect(Math.abs(short.totalSec - 240) / 240).toBeLessThan(0.05);
    expect(Math.abs(long.totalSec - 240) / 240).toBeLessThan(0.05);
    // The long one had to squeeze; the short one had room to breathe.
    expect(long.slides[0]?.durationSec).toBeLessThan(short.slides[0]?.durationSec ?? 0);
  });

  it('scales photographs and leaves the cards alone', () => {
    const slides: TimingSlide[] = [
      { id: 'title', kind: 'title', transitionOut: crossfade, chapterId: 'open' },
      { id: 'quote', kind: 'quote', transitionOut: crossfade, chapterId: 'c1' },
      ...photos(20),
    ];
    const timing = assignTimings(slides, { targetSec: 150 });
    const byId = new Map(timing.slides.map((slide) => [slide.slideId, slide.durationSec]));
    expect(byId.get('title')).toBe(TITLE_SEC);
    expect(byId.get('quote')).toBe(QUOTE_SEC);
  });

  it('keeps the relative length of a photograph the family lengthened', () => {
    const slides = photos(20, 4.5);
    const nudged = slides.map((slide, i) => (i === 3 ? { ...slide, durationSec: 5.5 } : slide));
    const timing = assignTimings(nudged, { targetSec: 100 });
    const durations = timing.slides.map((slide) => slide.durationSec);
    expect(durations[3]).toBeGreaterThan(durations[2] as number);
  });

  it('leaves holds alone when no target is given', () => {
    const timing = assignTimings(photos(5, 6));
    for (const slide of timing.slides) expect(slide.durationSec).toBe(6);
  });
});

describe('beat snapping', () => {
  // Hand-written grid: 120bpm, a beat every half second, a phrase every four.
  const grid: BeatGrid = {
    bpm: 120,
    beats: Array.from({ length: 80 }, (_, i) => i * 0.5),
    phrases: Array.from({ length: 10 }, (_, i) => i * 4),
  };

  it('prefers a phrase to a beat', () => {
    expect(snapBoundary(grid, 8.3)).toBe(8);
    // 10.4 is 2.4s from the nearest phrase but 0.1s from a beat
    expect(snapBoundary(grid, 10.4)).toBe(10.5);
  });

  it('leaves a boundary alone when nothing musical is close enough', () => {
    const sparse: BeatGrid = { bpm: 60, beats: [0, 30], phrases: [0, 30] };
    expect(snapBoundary(sparse, 12)).toBeUndefined();
    expect(snapBoundary(grid, 8.3, 0.1)).toBeUndefined();
  });

  it('lands slide changes on phrase boundaries', () => {
    const slides = photos(4, 4.3).map((slide) => ({ ...slide, transitionOut: cut }));
    const timing = assignTimings(slides, { beatGrid: grid });
    // With hard cuts a boundary is simply the next slide's start.
    for (const slide of timing.slides.slice(1)) {
      expect(grid.phrases).toContain(slide.startSec);
    }
  });

  it('snaps the moment the next picture starts to arrive, not the moment the last one ends', () => {
    const slides = photos(3, 4.5);
    const timing = assignTimings(slides, { beatGrid: grid });
    const second = timing.slides[1];
    expect(second?.startSec).toBe(4);
  });

  it('refuses a snap that would push a photograph out of its band', () => {
    // A three-second hold with the nearest phrase 0.6s earlier would land at
    // 2.4s — inside the tolerance, outside the band. The band wins.
    const tight: BeatGrid = { bpm: 100, beats: [2.4], phrases: [2.4] };
    const slides = photos(2, PHOTO_MIN_SEC).map((slide) => ({ ...slide, transitionOut: cut }));
    const timing = assignTimings(slides, { beatGrid: tight });
    expect(timing.slides[0]?.durationSec).toBe(PHOTO_MIN_SEC);
  });

  it('moves a boundary no further than the tolerance', () => {
    const slides = photos(6, 4.5).map((slide) => ({ ...slide, transitionOut: cut }));
    const unsnapped = assignTimings(slides);
    const snapped = assignTimings(slides, { beatGrid: grid });
    for (const [i, slide] of snapped.slides.entries()) {
      const before = unsnapped.slides[i]?.durationSec ?? 0;
      expect(Math.abs(slide.durationSec - before)).toBeLessThanOrEqual(SNAP_TOLERANCE_SEC + 1e-9);
    }
  });
});

describe('determinism', () => {
  const grid: BeatGrid = {
    bpm: 96,
    beats: Array.from({ length: 200 }, (_, i) => Number((i * 0.625).toFixed(3))),
    phrases: Array.from({ length: 25 }, (_, i) => Number((i * 5).toFixed(3))),
  };

  it('gives the same answer every time', () => {
    const slides = [
      { id: 'title', kind: 'title' as const, transitionOut: crossfade, chapterId: 'open' },
      ...photos(37),
      { id: 'closing', kind: 'closing' as const, chapterId: 'close' },
    ];
    const once = assignTimings(slides, { targetSec: 213, beatGrid: grid });
    const twice = assignTimings(slides, { targetSec: 213, beatGrid: grid });
    expect(twice).toEqual(once);
  });

  it('puts every boundary on a whole frame, so preview and render agree', () => {
    const timing = assignTimings(photos(12), { targetSec: 61, fps: 30 });
    for (const slide of timing.slides) {
      expect(Number.isInteger(Math.round(slide.durationSec * 30 * 1e6) / 1e6)).toBe(true);
      expect(Math.abs(slide.startSec * 30 - Math.round(slide.startSec * 30))).toBeLessThan(1e-6);
    }
  });

  it('handles an empty slideshow without inventing one', () => {
    expect(assignTimings([])).toEqual({ slides: [], totalSec: 0, fps: 30 });
  });
});

/* -------------------------------------------------------------------------- */
/* cut projection                                                              */
/* -------------------------------------------------------------------------- */

function photoSlide(suitability: number): Slide {
  return {
    kind: 'photo',
    assetId: `asset-${suitability}`,
    variant: 'render2400',
    durationSec: 4.5,
    kenBurns: {
      from: { x: 0, y: 0, w: 1, h: 1 },
      to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      easing: 'easeInOut',
    },
    transitionOut: crossfade,
    suitability,
  };
}

/** Three chapters of `perChapter` photographs, suitability descending. */
function makeEdl(chapters: number, perChapter: number): Edl {
  const slides: Record<string, Slide> = {
    'opening-title': {
      kind: 'title',
      text: 'Margaret Anne Doyle',
      subtext: '1938 — 2024',
      durationSec: TITLE_SEC,
      transitionOut: crossfade,
    },
    'closing-card': { kind: 'closing', line1: 'Margaret', line2: '1938 — 2024', durationSec: 6 },
  };
  const edlChapters = [{ id: 'opening', title: 'Opening', slideIds: ['opening-title'] }];

  for (let c = 0; c < chapters; c += 1) {
    const ids: string[] = [];
    const quoteId = `c${c + 1}-q1`;
    slides[quoteId] = {
      kind: 'quote',
      text: 'She always said the garden would outlive her.',
      attribution: 'Her daughter, Anne',
      durationSec: QUOTE_SEC,
      transitionOut: crossfade,
    };
    ids.push(quoteId);
    for (let s = 0; s < perChapter; s += 1) {
      const id = `c${c + 1}-s${s + 1}`;
      // Deterministic, distinct, and different per chapter.
      slides[id] = photoSlide(Number((0.2 + s * 0.01 + c * 0.001).toFixed(3)));
      ids.push(id);
    }
    edlChapters.push({ id: `c${c + 1}`, title: `Chapter ${c + 1}`, slideIds: ids });
  }

  edlChapters.push({ id: 'closing', title: 'Closing', slideIds: ['closing-card'] });

  return EdlSchema.parse({
    version: 1,
    projectId: 'project-1',
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    audio: { mode: 'sideloaded', startOffsetSec: 0 },
    theme: { id: 'quiet-linen' },
    chapters: edlChapters,
    slides,
    cuts: { service: { targetSec: 300 }, family: { targetSec: 600 } },
  });
}

describe('cut projection', () => {
  it('the family cut keeps every slide', () => {
    const edl = makeEdl(3, 20);
    const timeline = projectCut(edl, 'family');
    expect(timeline.droppedSlideIds).toEqual([]);
    expect(timeline.slides).toHaveLength(3 * 21 + 2);
  });

  it('the service cut comes in around five minutes', () => {
    const timeline = projectCut(makeEdl(4, 45), 'service');
    expect(timeline.totalSec).toBeLessThanOrEqual(300 * 1.05);
    expect(timeline.droppedSlideIds.length).toBeGreaterThan(0);
  });

  it('drops the weakest photographs first', () => {
    const edl = makeEdl(3, 45);
    const timeline = projectCut(edl, 'service');
    const droppedSuitability = timeline.droppedSlideIds.map((id) => {
      const slide = edl.slides[id];
      return slide?.kind === 'photo' ? (slide.suitability ?? 1) : 1;
    });
    const keptSuitability = timeline.slides
      .map((slide) => edl.slides[slide.slideId])
      .filter((slide): slide is Extract<Slide, { kind: 'photo' }> => slide?.kind === 'photo')
      .map((slide) => slide.suitability ?? 1);
    expect(Math.max(...droppedSuitability)).toBeLessThanOrEqual(Math.min(...keptSuitability));
  });

  it('never drops the title, a quote card or the closing', () => {
    const edl = makeEdl(5, 40);
    const timeline = projectCut(edl, 'service');
    for (const id of timeline.droppedSlideIds) {
      expect(edl.slides[id]?.kind).toBe('photo');
    }
  });

  it('leaves every chapter at least one photograph', () => {
    // Far more than five minutes' worth, so the projection has to cut deep.
    const edl = makeEdl(8, 40);
    const timeline = projectCut(edl, 'service');
    const dropped = new Set(timeline.droppedSlideIds);
    for (const chapter of edl.chapters) {
      const photosLeft = chapter.slideIds.filter(
        (id) => edl.slides[id]?.kind === 'photo' && !dropped.has(id),
      );
      if (chapter.slideIds.some((id) => edl.slides[id]?.kind === 'photo')) {
        expect(photosLeft.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('honours an explicit include list when the family has made one', () => {
    const edl = makeEdl(2, 5);
    const chosen = ['opening-title', 'c1-s1', 'c2-s1', 'closing-card'];
    const timeline = projectCut({ ...edl, cuts: { ...edl.cuts, service: { targetSec: 300, includeSlideIds: chosen } } }, 'service');
    expect(timeline.slides.map((slide) => slide.slideId)).toEqual(chosen);
  });

  it('skips the slides a family removed', () => {
    const edl = makeEdl(2, 5);
    const trimmed: Edl = { ...edl, omittedSlideIds: ['c1-s2', 'c2-s3'] };
    const ids = projectCut(trimmed, 'family').slides.map((slide) => slide.slideId);
    expect(ids).not.toContain('c1-s2');
    expect(ids).not.toContain('c2-s3');
  });

  it('marks where every chapter starts, in order', () => {
    const timeline = projectCut(makeEdl(3, 10), 'family');
    const starts = timeline.chapters.map((chapter) => chapter.startSec);
    expect(timeline.chapters.map((c) => c.id)).toEqual(['opening', 'c1', 'c2', 'c3', 'closing']);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('gives the same timeline every time it is asked', () => {
    const edl = makeEdl(4, 25);
    expect(projectCut(edl, 'service')).toEqual(projectCut(edl, 'service'));
  });

  it('reports a whole number of frames for the renderer', () => {
    const timeline = projectCut(makeEdl(2, 10), 'family');
    expect(durationInFrames(timeline)).toBe(Math.round(timeline.totalSec * 30));
  });
});

describe('helpers', () => {
  it('knows the shortest a run of slides could be', () => {
    const slides = photos(5, 7).map((slide) => ({ ...slide, transitionOut: cut }));
    expect(floorDuration(slides)).toBe(5 * PHOTO_MIN_SEC);
    expect(totalWithOverlap(slides, [7, 7, 7, 7, 7])).toBe(35);
  });

  it('writes the fitted holds back onto the slides', () => {
    const edl = makeEdl(2, 30);
    const fitted = withFittedDurations(edl);
    const timeline = projectCut(fitted, 'family');
    for (const slide of timeline.slides) {
      expect(fitted.slides[slide.slideId]?.durationSec).toBeCloseTo(slide.durationSec, 5);
    }
  });

  it('says lengths the way a person would', () => {
    expect(describeLength(42)).toBe('42 seconds');
    expect(describeLength(300)).toBe('5 minutes');
    expect(describeLength(305)).toBe('5 min 05 sec');
    expect(describeLength(60)).toBe('1 minute');
  });
});
