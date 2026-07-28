import { describe, expect, it } from 'vitest';
import { EdlSchema, type Edl } from '@col/schemas';
import {
  DEFAULT_DURATION_IN_FRAMES,
  DEFAULT_EDL,
  TRIBUTE_FPS,
  TRIBUTE_HEIGHT,
  TRIBUTE_WIDTH,
  firstTitleSlide,
} from './index';

describe('composition defaults', () => {
  it('matches the delivery format of record (1080p30)', () => {
    expect([TRIBUTE_WIDTH, TRIBUTE_HEIGHT, TRIBUTE_FPS]).toEqual([1920, 1080, 30]);
    expect(DEFAULT_DURATION_IN_FRAMES).toBe(150);
  });

  it('ships a default EDL that is a valid EDL', () => {
    expect(() => EdlSchema.parse(DEFAULT_EDL)).not.toThrow();
  });
});

describe('firstTitleSlide', () => {
  it('reads the title card in chapter order', () => {
    const edl: Edl = {
      ...DEFAULT_EDL,
      chapters: [{ id: 'c1', title: 'Opening', slideIds: ['later-title', 'earlier-title'] }],
      slides: {
        'earlier-title': {
          kind: 'title',
          text: 'Ignored',
          durationSec: 4,
          transitionOut: { kind: 'cut', durationSec: 0 },
        },
        'later-title': {
          kind: 'title',
          text: 'Margaret Anne Doyle',
          subtext: '1938 — 2024',
          durationSec: 5,
          transitionOut: { kind: 'crossfade', durationSec: 1 },
        },
      },
    };
    expect(EdlSchema.safeParse(edl).success).toBe(true);
    expect(firstTitleSlide(edl)?.text).toBe('Margaret Anne Doyle');
  });

  it('falls back to any title slide outside a chapter', () => {
    const edl: Edl = { ...DEFAULT_EDL, chapters: [] };
    expect(firstTitleSlide(edl)?.text).toBe('In loving memory');
  });

  it('returns undefined when there is no title slide at all', () => {
    const edl: Edl = { ...DEFAULT_EDL, chapters: [], slides: {} };
    expect(firstTitleSlide(edl)).toBeUndefined();
  });
});
