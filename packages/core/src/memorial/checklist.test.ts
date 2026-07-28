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
  it('always returns the same three cards, in the same order', () => {
    const { cards } = computeChecklist(memorial, { photos: 0, memories: 0 });
    expect(cards.map((c) => c.id)).toEqual(['photos', 'story', 'slideshow']);
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

  it('reports flags that can be persisted on the memorial row', () => {
    const done = computeChecklist(
      { id: 'm-1', intakeCompletedAt: 123 },
      { photos: 12, memories: 3 },
    );
    expect(done.flags).toEqual({
      intakeComplete: true,
      hasPhotos: true,
      hasMemories: true,
      enoughPhotos: true,
      readyToBuild: true,
    });
    expect(Object.values(done.flags).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('points every card at a route under the memorial', () => {
    const { cards } = computeChecklist(memorial, { photos: 0, memories: 0 });
    for (const c of cards) expect(c.href.startsWith('/m/m-1/')).toBe(true);
  });
});
