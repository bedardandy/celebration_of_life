import { describe, expect, it } from 'vitest';
import { EdlSchema, type Edl } from '@col/schemas';
import {
  EdlEditError,
  NUDGE_SEC,
  applyEdit,
  applyEditAndRefit,
  canNudge,
  moveSlide,
  nudgeDuration,
  removeSlide,
  restoreSlide,
  setCaption,
  swapPhoto,
} from './edit';
import { PHOTO_MAX_SEC, PHOTO_MIN_SEC, orderedSlides, projectCut } from './timing';

const crossfade = { kind: 'crossfade' as const, durationSec: 0.8 };
const kenBurns = {
  from: { x: 0, y: 0, w: 1, h: 1 },
  to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  easing: 'easeInOut' as const,
};

function edl(): Edl {
  return EdlSchema.parse({
    version: 1,
    projectId: 'project-1',
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    audio: { mode: 'sideloaded', startOffsetSec: 0 },
    theme: { id: 'quiet-linen' },
    chapters: [
      { id: 'opening', title: 'Opening', slideIds: ['title'] },
      { id: 'c1', title: 'Where she began', slideIds: ['c1-s1', 'c1-s2'] },
      { id: 'c2', title: 'Later on', slideIds: ['c2-s1'] },
      { id: 'closing', title: 'Closing', slideIds: ['closing'] },
    ],
    slides: {
      title: {
        kind: 'title',
        text: 'Margaret Anne Doyle',
        durationSec: 4,
        transitionOut: crossfade,
      },
      'c1-s1': {
        kind: 'photo',
        assetId: 'asset-1',
        variant: 'render2400',
        durationSec: 4.5,
        kenBurns,
        transitionOut: crossfade,
        suitability: 0.8,
      },
      'c1-s2': {
        kind: 'photo',
        assetId: 'asset-2',
        variant: 'render2400',
        durationSec: 4.5,
        kenBurns,
        caption: { text: 'On the beach', position: 'lower-third' },
        transitionOut: crossfade,
      },
      'c2-s1': {
        kind: 'photo',
        assetId: 'asset-3',
        variant: 'render2400',
        durationSec: 4.5,
        kenBurns,
        transitionOut: crossfade,
      },
      closing: { kind: 'closing', line1: 'Margaret', line2: '1938 — 2024', durationSec: 6 },
    },
    cuts: { service: { targetSec: 300 }, family: { targetSec: 420 } },
  });
}

describe('captions', () => {
  it('writes one, and an empty box takes it away again', () => {
    const withCaption = setCaption(edl(), 'c1-s1', '  The kitchen table, 1974 ');
    const slide = withCaption.slides['c1-s1'];
    expect(slide?.kind === 'photo' && slide.caption?.text).toBe('The kitchen table, 1974');

    const cleared = setCaption(withCaption, 'c1-s1', '   ');
    const after = cleared.slides['c1-s1'];
    expect(after?.kind === 'photo' && after.caption).toBeUndefined();
  });

  it('will not caption a card', () => {
    expect(() => setCaption(edl(), 'title', 'no')).toThrow(EdlEditError);
  });
});

describe('a bit longer, a bit shorter', () => {
  it('moves in half seconds', () => {
    const longer = nudgeDuration(edl(), 'c1-s1', NUDGE_SEC);
    expect(longer.slides['c1-s1']?.durationSec).toBe(5);
    const shorter = nudgeDuration(longer, 'c1-s1', -NUDGE_SEC);
    expect(shorter.slides['c1-s1']?.durationSec).toBe(4.5);
  });

  it('stops at the edges of the band', () => {
    let current = edl();
    for (let i = 0; i < 20; i += 1) current = nudgeDuration(current, 'c1-s1', NUDGE_SEC);
    expect(current.slides['c1-s1']?.durationSec).toBe(PHOTO_MAX_SEC);
    for (let i = 0; i < 40; i += 1) current = nudgeDuration(current, 'c1-s1', -NUDGE_SEC);
    expect(current.slides['c1-s1']?.durationSec).toBe(PHOTO_MIN_SEC);
  });

  it('says up front when a button would do nothing', () => {
    const base = edl();
    expect(canNudge(base, 'c1-s1', NUDGE_SEC)).toBe(true);
    expect(canNudge(base, 'title', NUDGE_SEC)).toBe(false);
    const maxed = nudgeDuration(base, 'c1-s1', 10);
    expect(canNudge(maxed, 'c1-s1', NUDGE_SEC)).toBe(false);
    expect(canNudge(maxed, 'c1-s1', -NUDGE_SEC)).toBe(true);
  });

  it('refuses to hurry a quote card', () => {
    expect(() => nudgeDuration(edl(), 'closing', -NUDGE_SEC)).toThrow(EdlEditError);
  });
});

describe('moving a slide', () => {
  it('swaps it with its neighbour', () => {
    const moved = moveSlide(edl(), 'c1-s2', 'up');
    expect(orderedSlides(moved).map((s) => s.id)).toEqual([
      'title',
      'c1-s2',
      'c1-s1',
      'c2-s1',
      'closing',
    ]);
  });

  it('lets a slide cross into the next chapter', () => {
    const moved = moveSlide(edl(), 'c2-s1', 'up');
    const chapter = moved.chapters.find((c) => c.id === 'c1');
    expect(chapter?.slideIds).toContain('c2-s1');
  });

  it('does nothing at the ends, rather than complaining', () => {
    const base = edl();
    expect(moveSlide(base, 'title', 'up')).toEqual(base);
    expect(moveSlide(base, 'closing', 'down')).toEqual(base);
  });

  it('leaves removed slides exactly where they were', () => {
    const trimmed = removeSlide(edl(), 'c1-s1');
    const moved = moveSlide(trimmed, 'c2-s1', 'up');
    expect(moved.chapters.find((c) => c.id === 'c1')?.slideIds).toContain('c1-s1');
    expect(restoreSlide(moved, 'c1-s1').chapters.find((c) => c.id === 'c1')?.slideIds[0]).toBe(
      'c1-s1',
    );
  });
});

describe('swapping a photograph', () => {
  it('keeps the framing and the hold with the slot', () => {
    const nudged = nudgeDuration(edl(), 'c1-s1', NUDGE_SEC);
    const swapped = swapPhoto(nudged, 'c1-s1', {
      assetId: 'asset-9',
      caption: 'Her sister Peg',
      suitability: 0.55,
      width: 1200,
      height: 1600,
    });
    const slide = swapped.slides['c1-s1'];
    expect(slide?.kind).toBe('photo');
    if (slide?.kind === 'photo') {
      expect(slide.assetId).toBe('asset-9');
      expect(slide.durationSec).toBe(5);
      expect(slide.kenBurns).toEqual(kenBurns);
      expect(slide.caption?.text).toBe('Her sister Peg');
      expect(slide.sourceAspect).toBeCloseTo(0.75, 4);
    }
  });

  it('drops the old caption when the new photograph has none', () => {
    const swapped = swapPhoto(edl(), 'c1-s2', { assetId: 'asset-9' });
    const slide = swapped.slides['c1-s2'];
    expect(slide?.kind === 'photo' && slide.caption).toBeUndefined();
  });
});

describe('removing, and putting back', () => {
  it('takes a slide out of the video without losing it', () => {
    const trimmed = removeSlide(edl(), 'c1-s2');
    expect(trimmed.slides['c1-s2']).toBeDefined();
    expect(projectCut(trimmed, 'family').slides.map((s) => s.slideId)).not.toContain('c1-s2');
  });

  it('puts it back exactly where it was', () => {
    const base = edl();
    expect(restoreSlide(removeSlide(base, 'c1-s1'), 'c1-s1')).toEqual(base);
  });

  it('is quiet about removing something twice', () => {
    const once = removeSlide(edl(), 'c1-s1');
    expect(removeSlide(once, 'c1-s1')).toEqual(once);
    expect(restoreSlide(once, 'c2-s1')).toEqual(once);
  });
});

describe('applying an edit', () => {
  it('routes every button on the preview screen', () => {
    const base = edl();
    expect(applyEdit(base, { op: 'longer', slideId: 'c1-s1' }).slides['c1-s1']?.durationSec).toBe(
      5,
    );
    expect(applyEdit(base, { op: 'shorter', slideId: 'c1-s1' }).slides['c1-s1']?.durationSec).toBe(
      4,
    );
    expect(applyEdit(base, { op: 'remove', slideId: 'c1-s1' }).omittedSlideIds).toEqual(['c1-s1']);
    expect(
      orderedSlides(applyEdit(base, { op: 'move-down', slideId: 'c1-s1' })).map((s) => s.id)[2],
    ).toBe('c1-s1');
  });

  it('refits the holds after a structural change but not after a nudge', () => {
    const base = edl();
    const nudged = applyEditAndRefit(base, { op: 'longer', slideId: 'c1-s1' });
    expect(nudged.slides['c1-s1']?.durationSec).toBe(5);

    const trimmed = applyEditAndRefit(base, { op: 'remove', slideId: 'c1-s1' });
    const timeline = projectCut(trimmed, 'family');
    for (const slide of timeline.slides) {
      expect(trimmed.slides[slide.slideId]?.durationSec).toBeCloseTo(slide.durationSec, 5);
    }
  });

  it('never produces an EDL that would not parse', () => {
    let current = edl();
    for (const edit of [
      { op: 'remove' as const, slideId: 'c1-s2' },
      { op: 'move-down' as const, slideId: 'c1-s1' },
      { op: 'caption' as const, slideId: 'c1-s1', text: 'A line' },
      { op: 'restore' as const, slideId: 'c1-s2' },
      { op: 'swap' as const, slideId: 'c1-s1', replacement: { assetId: 'asset-x' } },
    ]) {
      current = applyEditAndRefit(current, edit);
      expect(() => EdlSchema.parse(current)).not.toThrow();
    }
  });
});
