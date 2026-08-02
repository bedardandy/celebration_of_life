import { describe, expect, it } from 'vitest';
import {
  COMFORTABLE_PHOTO_COUNT,
  MIN_MEMORIES_FOR_SLIDESHOW,
  MIN_PHOTOS_FOR_SLIDESHOW,
  computeChecklist,
  type CardId,
  type ChecklistCard,
} from './checklist';

const memorial = { id: 'm-1', intakeCompletedAt: null as number | null };

function card(cards: ChecklistCard[], id: CardId): ChecklistCard {
  const found = cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
}

describe('computeChecklist', () => {
  it('always returns the same four cards, in the same order', () => {
    const { cards } = computeChecklist(memorial, { photos: 0, memories: 0 });
    expect(cards.map((c) => c.id)).toEqual(['photos', 'story', 'slideshow', 'speeches']);
  });

  it('starts everything empty but never blank', () => {
    const { cards, readyToBuild } = computeChecklist(memorial, { photos: 0, memories: 0 });
    expect(card(cards, 'photos').state).toBe('not-started');
    expect(card(cards, 'story').state).toBe('not-started');
    expect(card(cards, 'slideshow').state).toBe('locked');
    expect(readyToBuild).toBe(false);
    for (const c of cards) {
      expect(c.statusLine.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the slideshow locked, kindly, until there is enough to work with', () => {
    const { cards } = computeChecklist(memorial, {
      photos: MIN_PHOTOS_FOR_SLIDESHOW - 1,
      memories: MIN_MEMORIES_FOR_SLIDESHOW,
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.state).toBe('locked');
    expect(slideshow.lockedReason).toBe('This opens once you have a few photos and memories.');
  });

  it('locks the slideshow when photos arrived but no memories did', () => {
    const { cards } = computeChecklist(memorial, { photos: 50, memories: 0 });
    expect(card(cards, 'slideshow').state).toBe('locked');
  });

  it('unlocks the slideshow at a few photos and one memory', () => {
    const result = computeChecklist(memorial, {
      photos: MIN_PHOTOS_FOR_SLIDESHOW,
      memories: MIN_MEMORIES_FOR_SLIDESHOW,
    });
    expect(card(result.cards, 'slideshow').state).toBe('not-started');
    expect(card(result.cards, 'slideshow').lockedReason).toBeUndefined();
    expect(result.readyToBuild).toBe(true);
  });

  it('moves cards to ready once there is comfortably enough', () => {
    const { cards } = computeChecklist(memorial, { photos: COMFORTABLE_PHOTO_COUNT, memories: 8 });
    expect(card(cards, 'photos').state).toBe('ready');
    expect(card(cards, 'story').state).toBe('ready');
  });

  it('counts in words a person would use', () => {
    const one = computeChecklist(memorial, { photos: 1, memories: 1 });
    expect(card(one.cards, 'photos').statusLine).toContain('1 photo ');
    expect(card(one.cards, 'story').statusLine).toContain('1 memory');
    const two = computeChecklist(memorial, { photos: 2, memories: 2 });
    expect(card(two.cards, 'photos').statusLine).toContain('2 photos');
    expect(card(two.cards, 'story').statusLine).toContain('2 memories');
  });

  it('suggests exactly one next step, and it changes as things arrive', () => {
    expect(computeChecklist(memorial, { photos: 0, memories: 0 }).nextStep).toBe(
      'The most helpful next step is gathering a few photos.',
    );
    expect(
      computeChecklist(memorial, { photos: MIN_PHOTOS_FOR_SLIDESHOW, memories: 0 }).nextStep,
    ).toBe('The most helpful next step is writing down one memory.');
    expect(computeChecklist(memorial, { photos: 60, memories: 6 }).nextStep).toBe(
      'You have what you need. Building the slideshow is the next step.',
    );
  });

  it('turns the slideshow card into a way back into the slideshow once one exists', () => {
    const { cards, nextStep } = computeChecklist(memorial, {
      photos: 30,
      memories: 4,
      slideshow: { hasEdl: true, slideCount: 42, lengthLabel: '5 minutes' },
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.state).toBe('ready');
    expect(slideshow.href).toBe('/m/m-1/preview');
    expect(slideshow.statusLine).toContain('42 slides');
    expect(slideshow.statusLine).toContain('5 minutes');
    expect(nextStep).toContain('ready to watch');
  });

  it('unlocks the card even when the thresholds were never met, if a slideshow exists', () => {
    // Someone who uploaded eight photographs and built anyway must not be told
    // the card is locked while their own slideshow is sitting there.
    const { cards } = computeChecklist(memorial, {
      photos: 8,
      memories: 0,
      slideshow: { hasEdl: true, slideCount: 9 },
    });
    expect(card(cards, 'slideshow').state).toBe('ready');
  });

  it('says so plainly while one is being put together', () => {
    const { cards, nextStep } = computeChecklist(memorial, {
      photos: 30,
      memories: 4,
      slideshow: { hasEdl: false, building: true },
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.state).toBe('in-progress');
    expect(slideshow.statusLine).toContain('Putting it together');
    expect(nextStep).toContain('being put together');
  });

  it('moves the card on to making the video once the music is settled', () => {
    const { cards, nextStep } = computeChecklist(memorial, {
      photos: 40,
      memories: 4,
      slideshow: {
        hasEdl: true,
        slideCount: 42,
        lengthLabel: '5 minutes',
        musicChosen: true,
        musicLine: 'Evensong is included in the video, so it can be shared anywhere.',
      },
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.title).toBe('Make the video');
    expect(slideshow.href).toBe('/m/m-1/deliver');
    expect(slideshow.statusLine).toContain('Evensong');
    expect(nextStep).toContain('making the video file');
  });

  it('says a video is being made, and that nothing needs them meanwhile', () => {
    const { cards, nextStep } = computeChecklist(memorial, {
      photos: 40,
      memories: 4,
      slideshow: { hasEdl: true, musicChosen: true, rendering: true },
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.state).toBe('in-progress');
    expect(slideshow.statusLine).toContain('close this');
    expect(nextStep).toContain('Nothing needs you');
  });

  it('points a family with a finished video at getting it into the room', () => {
    const { cards, nextStep, flags } = computeChecklist(memorial, {
      photos: 40,
      memories: 4,
      // A backup copy still rendering must not hide a video that is ready.
      slideshow: { hasEdl: true, musicChosen: true, rendering: true, delivered: true },
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.title).toBe('The video is ready');
    expect(slideshow.href).toBe('/m/m-1/deliver');
    expect(nextStep).toContain('getting it to the venue');
    expect(flags['delivered']).toBe(true);
  });

  it('folds in what family said after watching, once there is a video', () => {
    const { cards } = computeChecklist(memorial, {
      photos: 40,
      memories: 4,
      slideshow: { hasEdl: true, musicChosen: true, delivered: true },
      reviewNotes: 3,
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.statusLine).toContain('Notes from family (3)');
    // And the card takes them straight to those notes.
    expect(slideshow.href).toBe('/m/m-1/review');
  });

  it('says nothing about notes when nobody has left any', () => {
    const { cards } = computeChecklist(memorial, {
      photos: 40,
      memories: 4,
      slideshow: { hasEdl: true, musicChosen: true, delivered: true },
      reviewNotes: 0,
    });
    const slideshow = card(cards, 'slideshow');
    expect(slideshow.statusLine).not.toMatch(/note/i);
    expect(slideshow.href).toBe('/m/m-1/deliver');
  });

  it('reports flags that can be persisted on the memorial row', () => {
    const done = computeChecklist(
      { id: 'm-1', intakeCompletedAt: 123 },
      { photos: 12, memories: 3 },
    );
    expect(done.flags).toEqual({
      intakeComplete: true,
      hasPhotos: true,
      hasMemories: true,
      hasStory: false,
      enoughPhotos: true,
      readyToBuild: true,
      hasSlideshow: false,
      hasSpeech: false,
      programReady: false,
      // Delivery flags: false rather than absent, so a diff over time can tell
      // "not yet" from "this memorial predates the question".
      musicChosen: false,
      rendering: false,
      delivered: false,
    });
    expect(Object.values(done.flags).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('points every card at a route under the memorial', () => {
    const { cards } = computeChecklist(memorial, { photos: 0, memories: 0 });
    for (const c of cards) expect(c.href.startsWith('/m/m-1/')).toBe(true);
  });
});

describe('the speeches and program card', () => {
  const memorial = { id: 'm-1', intakeCompletedAt: null };
  const speechCard = (counts: Parameters<typeof computeChecklist>[1]) =>
    computeChecklist(memorial, counts).cards.find((card) => card.id === 'speeches');

  it('offers itself from the very first evening, with nothing else in place', () => {
    const card = speechCard({ photos: 0, memories: 0 });
    expect(card?.state).toBe('not-started');
    // Never locked: a eulogy is often the first thing an organiser wants to do.
    expect(card?.lockedReason).toBeUndefined();
    expect(card?.href).toBe('/m/m-1/speeches');
    expect(card?.statusLine).toContain('eulogy');
  });

  it('says a speech is waiting once one has been set up', () => {
    const card = speechCard({ photos: 0, memories: 0, speeches: { started: 1, drafted: 0 } });
    expect(card?.state).toBe('in-progress');
    expect(card?.statusLine).toContain('waiting for its first draft');
  });

  it('counts written speeches and the program together', () => {
    const card = speechCard({
      photos: 0,
      memories: 0,
      speeches: { started: 2, drafted: 2 },
      program: { started: true, ready: false },
    });
    expect(card?.state).toBe('in-progress');
    expect(card?.statusLine).toContain('2 speeches written');
    expect(card?.statusLine).toContain('part-way');
  });

  it('reads as ready only when there is a speech and a printable program', () => {
    const card = speechCard({
      photos: 0,
      memories: 0,
      speeches: { started: 1, drafted: 1 },
      program: { started: true, ready: true },
    });
    expect(card?.state).toBe('ready');
    expect(card?.statusLine).toContain('1 speech written');
    expect(card?.statusLine).toContain('ready to print');
  });

  it('flags a written speech and a finished program', () => {
    const { flags } = computeChecklist(memorial, {
      photos: 0,
      memories: 0,
      speeches: { started: 1, drafted: 1 },
      program: { started: true, ready: true },
    });
    expect(flags['hasSpeech']).toBe(true);
    expect(flags['programReady']).toBe(true);
  });
});

describe('the story card once the interview has run', () => {
  const memorial = { id: 'm-1', intakeCompletedAt: null };
  const storyCard = (counts: { photos: number; memories: number; storyChapters?: number }) =>
    computeChecklist(memorial, counts).cards.find((card) => card.id === 'story');

  it('counts chapters once there are any, in the family’s own words', () => {
    expect(storyCard({ photos: 0, memories: 0, storyChapters: 3 })?.statusLine).toBe(
      'Their story is taking shape — 3 chapters so far.',
    );
    expect(storyCard({ photos: 0, memories: 0, storyChapters: 1 })?.statusLine).toContain(
      '1 chapter so far',
    );
  });

  it('mentions what other people sent in alongside the chapters', () => {
    expect(storyCard({ photos: 0, memories: 2, storyChapters: 2 })?.statusLine).toContain(
      '2 memories from others',
    );
  });

  it('reads as ready once the story has an arc', () => {
    expect(storyCard({ photos: 0, memories: 0, storyChapters: 1 })?.state).toBe('in-progress');
    expect(storyCard({ photos: 0, memories: 0, storyChapters: 4 })?.state).toBe('ready');
  });

  it('still reads as not started when nothing at all has happened', () => {
    expect(storyCard({ photos: 0, memories: 0, storyChapters: 0 })?.state).toBe('not-started');
    expect(storyCard({ photos: 0, memories: 0 })?.state).toBe('not-started');
  });

  it('flags a story that exists', () => {
    expect(
      computeChecklist(memorial, { photos: 0, memories: 0, storyChapters: 2 }).flags['hasStory'],
    ).toBe(true);
  });
});
