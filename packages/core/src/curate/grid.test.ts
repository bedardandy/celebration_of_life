import { describe, expect, it } from 'vitest';
import {
  buildCurationView,
  duplicateCardLine,
  eraLabel,
  summarise,
  UNKNOWN_ERA,
  UNKNOWN_ERA_LABEL,
  type CurationAsset,
} from './grid';
import { findCoverageGaps, gapMessage, primaryGap } from './coverage';

let seq = 0;

function asset(overrides: Partial<CurationAsset> = {}): CurationAsset {
  seq += 1;
  return {
    id: `asset-${String(seq).padStart(3, '0')}`,
    originalFilename: 'photo.jpg',
    mime: 'image/jpeg',
    capturedAt: null,
    eraGuess: null,
    phash: null,
    qualityScore: 0.8,
    blurScore: 0.8,
    dupeGroupId: null,
    dupeRepresentative: false,
    needsIdentification: false,
    curationState: 'pending',
    ingestState: 'ready',
    ingestError: null,
    caption: null,
    uploadedByParticipantId: null,
    createdAt: 1_700_000_000_000 + seq,
    ...overrides,
  };
}

describe('era grouping', () => {
  it('puts photos in decades, oldest first, with the unknowns last', () => {
    const view = buildCurationView({
      assets: [
        asset({ eraGuess: '2000s' }),
        asset({ eraGuess: '1960s' }),
        asset({}),
        asset({ eraGuess: '1980s' }),
      ],
    });
    expect(view.groups.map((g) => g.era)).toEqual(['1960s', '1980s', '2000s', UNKNOWN_ERA]);
    expect(view.groups.at(-1)?.label).toBe(UNKNOWN_ERA_LABEL);
    expect(eraLabel('1960s')).toBe('1960s');
  });

  it('falls back to the capture time when nothing wrote an era', () => {
    const view = buildCurationView({
      assets: [asset({ capturedAt: Date.UTC(1975, 2, 1) })],
    });
    expect(view.groups[0]?.era).toBe('1970s');
  });

  it('orders a decade chronologically, and deterministically when it cannot', () => {
    const later = asset({ eraGuess: '1990s', capturedAt: Date.UTC(1995, 0, 1) });
    const earlier = asset({ eraGuess: '1990s', capturedAt: Date.UTC(1991, 0, 1) });
    const undated = asset({ eraGuess: '1990s' });
    const view = buildCurationView({ assets: [undated, later, earlier] });
    expect(view.groups[0]?.cards.map((c) => c.asset.id)).toEqual([
      earlier.id,
      later.id,
      undated.id,
    ]);
  });
});

describe('duplicate groups', () => {
  it('collapses a burst to one card and keeps the rest to hand', () => {
    const a = asset({ dupeGroupId: 'g1', qualityScore: 0.4 });
    const b = asset({ dupeGroupId: 'g1', qualityScore: 0.9, dupeRepresentative: true });
    const c = asset({ dupeGroupId: 'g1', qualityScore: 0.6 });
    const alone = asset({});

    const view = buildCurationView({ assets: [a, b, c, alone] });
    const cards = view.groups[0]?.cards ?? [];
    expect(cards).toHaveLength(2);

    const collapsed = cards.find((card) => card.alternates.length > 0);
    expect(collapsed?.asset.id).toBe(b.id);
    // Sharpest first among the alternates, so "see all" reads sensibly.
    expect(collapsed?.alternates.map((x) => x.id)).toEqual([c.id, a.id]);
    expect(view.counts.duplicatesCollapsed).toBe(2);
    expect(duplicateCardLine(2)).toBe('3 similar photos — we picked the sharpest.');
  });

  it('shows the sharpest when nobody has chosen a representative', () => {
    const dim = asset({ dupeGroupId: 'g2', qualityScore: 0.2 });
    const sharp = asset({ dupeGroupId: 'g2', qualityScore: 0.7 });
    const view = buildCurationView({ assets: [dim, sharp] });
    expect(view.groups[0]?.cards[0]?.asset.id).toBe(sharp.id);
  });

  it('respects the family choosing a different one', () => {
    const dim = asset({ dupeGroupId: 'g3', qualityScore: 0.2, dupeRepresentative: true });
    const sharper = asset({ dupeGroupId: 'g3', qualityScore: 0.7 });
    const view = buildCurationView({ assets: [dim, sharper] });
    expect(view.groups[0]?.cards[0]?.asset.id).toBe(dim.id);
  });

  it('treats a group that lost its other members as an ordinary photo', () => {
    const only = asset({ dupeGroupId: 'g4' });
    const view = buildCurationView({ assets: [only] });
    expect(view.groups[0]?.cards[0]?.alternates).toEqual([]);
    expect(view.counts.duplicatesCollapsed).toBe(0);
  });
});

describe('flags and badges', () => {
  it('badges a blurry photo and never hides it', () => {
    const view = buildCurationView({ assets: [asset({ blurScore: 0.05 })] });
    const card = view.groups[0]?.cards[0];
    expect(card?.blurry).toBe(true);
    expect(card?.hidden).toBe(false);
    expect(card?.badge).toMatch(/still lovely/i);
    expect(view.counts.blurry).toBe(1);
  });

  it('explains a file we could not open, instead of showing a broken frame', () => {
    const view = buildCurationView({
      assets: [asset({ ingestState: 'failed', ingestError: 'We could not open this one.' })],
    });
    const card = view.groups[0]?.cards[0];
    expect(card?.problem).toBe('We could not open this one.');
    expect(card?.badge).toBeUndefined();
    expect(view.counts.problems).toBe(1);
  });

  it('carries "who is this?" and the note count onto the card', () => {
    const flagged = asset({ needsIdentification: true });
    const view = buildCurationView({
      assets: [flagged],
      noteCounts: new Map([[flagged.id, 2]]),
    });
    expect(view.groups[0]?.cards[0]?.needsIdentification).toBe(true);
    expect(view.groups[0]?.cards[0]?.noteCount).toBe(2);
    expect(view.counts.needsIdentification).toBe(1);
  });

  it('names the person a photo came from', () => {
    const fromMary = asset({ uploadedByParticipantId: 'p-mary' });
    const view = buildCurationView({
      assets: [fromMary],
      contributorNames: new Map([['p-mary', 'Mary']]),
    });
    expect(view.groups[0]?.cards[0]?.contributorName).toBe('Mary');
    expect(view.counts.contributors).toBe(1);
  });
});

describe('the counts line', () => {
  it('says what the dashboard says: photos, people, approved', () => {
    const view = buildCurationView({
      assets: [
        asset({ curationState: 'approved', uploadedByParticipantId: 'p1' }),
        asset({ curationState: 'approved', uploadedByParticipantId: 'p2' }),
        asset({ uploadedByParticipantId: 'p2' }),
      ],
    });
    expect(view.counts).toMatchObject({ photos: 3, approved: 2, contributors: 2 });
    expect(view.summary).toBe('3 photos from 2 people, 2 approved.');
  });

  it('never scolds an empty grid', () => {
    expect(summarise({
      photos: 0,
      approved: 0,
      hidden: 0,
      blurry: 0,
      duplicatesCollapsed: 0,
      needsIdentification: 0,
      contributors: 0,
      problems: 0,
      videos: 0,
    })).toBe('No photos yet. They will appear here as they arrive.');
  });

  it('gets the singulars right, because "1 photos" is a papercut', () => {
    const view = buildCurationView({ assets: [asset({ uploadedByParticipantId: 'p1' })] });
    expect(view.summary).toBe('1 photo from 1 person, 0 approved.');
  });
});

describe('coverage gaps', () => {
  const counts = (entries: [string, number][]) => new Map(entries);

  it('finds the hole between decades we do have', () => {
    const gaps = findCoverageGaps({
      birthYear: 1938,
      deathYear: 2026,
      countsByEra: counts([
        ['1950s', 4],
        ['1980s', 6],
        ['2010s', 12],
      ]),
    });
    expect(gaps.map((g) => g.era)).toEqual(['1960s', '1970s', '1990s', '2000s', '2020s']);
    expect(gaps[0]?.ageRange).toEqual({ from: 22, to: 31 });
    expect(gaps[0]?.message).toBe(
      'No photos from their twenties yet — someone may have a shoebox. Ask them?',
    );
  });

  it('says nothing at all when no photos have arrived yet', () => {
    expect(findCoverageGaps({ countsByEra: counts([]) })).toEqual([]);
    expect(findCoverageGaps({ countsByEra: counts([[UNKNOWN_ERA, 9]]) })).toEqual([]);
    expect(primaryGap([])).toBeUndefined();
  });

  it('never suggests a decade outside the life', () => {
    const gaps = findCoverageGaps({
      birthYear: 1990,
      deathYear: 2026,
      countsByEra: counts([
        ['1990s', 2],
        ['2020s', 3],
      ]),
    });
    expect(gaps.map((g) => g.era)).toEqual(['2000s', '2010s']);
  });

  it('offers one nudge, the earliest, because a list is a to-do list', () => {
    const gaps = findCoverageGaps({
      birthYear: 1938,
      countsByEra: counts([
        ['1950s', 1],
        ['1990s', 1],
      ]),
    });
    expect(primaryGap(gaps)?.era).toBe('1960s');
  });

  it('falls back to the decade when it does not know their age', () => {
    expect(gapMessage('1970s')).toBe(
      'No photos from the 1970s yet — someone may have a shoebox. Ask them?',
    );
  });
});
