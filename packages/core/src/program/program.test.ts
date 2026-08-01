/**
 * The printed program.
 *
 * The things checked here are the things that would be noticed at a funeral: an
 * order of service that arrives already filled in from the family's own
 * tradition, a life sketch that can be gone back on, and a plain-text version a
 * funeral home can paste into whatever they already use.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_PROVIDER_ID, getProvider, resetMockState } from '@col/ai';
import { createTestDb, insertOne, memorials, type Db, type Memorial } from '@col/db';
import { getPack } from '@col/tradition-packs';
import { saveDocVersion } from '../interview/store';
import { emptyLifeStoryDocument } from '../interview/doc-patch';
import {
  addOrderItem,
  defaultAcknowledgment,
  draftLifeSketch,
  emptyProgram,
  lifeDatesOf,
  moveOrderItem,
  nextProgramStep,
  previousProgramStep,
  programProgress,
  readingSuggestions,
  removeOrderItem,
  renameOrderItem,
} from './build';
import { PRINT_SHOP_NOTE, PROGRAM_PAGES, programToText, sketchFitNote } from './pages';
import { currentProgram, hasProgram, listProgramVersions, saveProgramVersion } from './store';

let db: Db;
let memorial: Memorial;

const provider = () => getProvider(MOCK_PROVIDER_ID);

function makeMemorial(overrides: Partial<Memorial> = {}): Memorial {
  return insertOne(db, memorials, {
    decedentName: 'Ruth Hartley',
    birthYear: 1936,
    deathYear: 2026,
    traditionSlug: 'secular',
    ...overrides,
  } as Partial<Memorial> as never);
}

beforeEach(() => {
  db = createTestDb();
  resetMockState();
  memorial = makeMemorial();
});

/* -------------------------------------------------------------------------- */

describe('the program a family starts from', () => {
  it('is never blank: name, dates, an order of service and a thank you', () => {
    const doc = emptyProgram(memorial, getPack('secular'));
    expect(doc.coverLine).toBe('In Loving Memory');
    expect(doc.fullName).toBe('Ruth Hartley');
    expect(doc.lifeDates).toBe('1936 — 2026');
    expect(doc.orderOfService.length).toBeGreaterThan(0);
    expect(doc.acknowledgments).toContain('Ruth Hartley');
    expect(doc.acknowledgments).toContain('thank you');
  });

  it('prefills the order of service from the family’s own tradition', () => {
    const catholic = emptyProgram(makeMemorial({ traditionSlug: 'catholic' }), getPack('catholic'));
    const secular = emptyProgram(makeMemorial({ traditionSlug: 'secular' }), getPack('secular'));
    const homegoing = emptyProgram(
      makeMemorial({ traditionSlug: 'homegoing' }),
      getPack('homegoing'),
    );

    const items = (doc: { orderOfService: { item: string }[] }) =>
      doc.orderOfService.map((entry) => entry.item).join(' | ');

    expect(items(catholic)).toContain('Liturgy of the Eucharist');
    expect(items(catholic)).toContain('Final Commendation and Farewell');
    expect(items(secular)).toContain('Tributes');
    expect(items(secular)).not.toContain('Liturgy of the Eucharist');
    expect(items(homegoing)).toContain('Reading of the obituary');
    expect(items(homegoing)).toContain('Repast');

    // Notes travel with the items — they are the part that names people.
    expect(catholic.orderOfService.some((entry) => entry.note)).toBe(true);
  });

  it('handles a family who only know one of the two years', () => {
    expect(lifeDatesOf({ birthYear: 1936, deathYear: 2026 })).toBe('1936 — 2026');
    expect(lifeDatesOf({ birthYear: null, deathYear: 2026 })).toBe('2026');
    expect(lifeDatesOf({ birthYear: 1936, deathYear: null })).toBe('1936 —');
    expect(lifeDatesOf({ birthYear: null, deathYear: null })).toBe('');
  });

  it('writes the acknowledgement out, because that is the sentence nobody can face', () => {
    expect(defaultAcknowledgment('Ruth Hartley')).toContain('doorsteps');
    expect(defaultAcknowledgment('Ruth Hartley')).toContain('Ruth would have been glad');
  });
});

/* -------------------------------------------------------------------------- */

describe('editing the order of service', () => {
  const base = () => emptyProgram(memorial, getPack('secular'));

  it('adds, renames, removes and moves with buttons rather than dragging', () => {
    let doc = base();
    const original = doc.orderOfService.length;

    doc = addOrderItem(doc, 'A poem read by Nell', 'Her granddaughter');
    expect(doc.orderOfService).toHaveLength(original + 1);
    expect(doc.orderOfService.at(-1)).toEqual({
      item: 'A poem read by Nell',
      note: 'Her granddaughter',
    });

    doc = renameOrderItem(doc, original, 'A poem');
    expect(doc.orderOfService.at(-1)).toEqual({ item: 'A poem' });

    doc = moveOrderItem(doc, original, -1);
    expect(doc.orderOfService[original - 1]?.item).toBe('A poem');

    doc = removeOrderItem(doc, original - 1);
    expect(doc.orderOfService).toHaveLength(original);
  });

  it('refuses to move an item off either end, quietly', () => {
    const doc = base();
    expect(moveOrderItem(doc, 0, -1)).toEqual(doc);
    expect(moveOrderItem(doc, doc.orderOfService.length - 1, 1)).toEqual(doc);
    expect(addOrderItem(doc, '   ')).toEqual(doc);
  });
});

/* -------------------------------------------------------------------------- */

describe('readings', () => {
  it('suggests what the tradition reaches for, and only prints what it may', () => {
    const catholic = readingSuggestions('catholic');
    expect(catholic.length).toBeGreaterThan(0);
    expect(catholic.some((reading) => /Psalm 23/i.test(reading.title))).toBe(true);
    for (const reading of catholic) expect(reading.source).not.toBe('');

    const secular = readingSuggestions('secular');
    expect(secular.some((reading) => /Do Not Stand at My Grave/i.test(reading.title))).toBe(true);

    // An unknown slug is a shrug, not a crash.
    expect(readingSuggestions('klingon')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('versions', () => {
  it('starts from a sensible document and appends every revision', () => {
    expect(hasProgram(db, memorial.id)).toBe(false);
    const start = currentProgram(db, memorial);
    expect(start.version).toBe(0);
    expect(start.doc.fullName).toBe('Ruth Hartley');

    saveProgramVersion(
      db,
      memorial.id,
      { ...start.doc, lifeSketch: 'A first go.' },
      'ai',
      'Drafted',
    );
    const second = currentProgram(db, memorial);
    expect(second.version).toBe(1);
    expect(second.doc.lifeSketch).toBe('A first go.');

    saveProgramVersion(
      db,
      memorial.id,
      { ...second.doc, lifeSketch: 'Anne rewrote it.' },
      'organizer',
    );
    expect(currentProgram(db, memorial).doc.lifeSketch).toBe('Anne rewrote it.');

    const versions = listProgramVersions(db, memorial.id);
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    // The earlier wording is still on disk, which is the whole point.
    expect(versions[1]?.doc.lifeSketch).toBe('A first go.');
    expect(hasProgram(db, memorial.id)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('the life sketch', () => {
  it('is drafted from the story the family wrote, and can be rewritten', async () => {
    const doc = emptyLifeStoryDocument({ fullName: 'Ruth Hartley' });
    doc.chapters.push({
      id: 'the-school',
      title: 'Thirty-one years of fourth grade',
      era: {},
      summary: 'She taught at Pinecrest until she retired.',
      anecdotes: [
        {
          id: 'a1',
          text: 'She kept a photograph of every class she ever taught.',
          source: 'interview',
          approved: true,
        },
      ],
      people: [],
      openQuestions: [],
    });
    saveDocVersion(db, memorial.id, doc, 'interview');

    const sketch = await draftLifeSketch(db, memorial, { provider: provider() });
    expect(sketch.providerId).toBe(MOCK_PROVIDER_ID);
    expect(sketch.text).toContain('Ruth was born in 1936');
    expect(sketch.text.split('\n\n').length).toBeGreaterThan(1);
  });

  it('says whether it will fit the page, without making it a rule', () => {
    expect(sketchFitNote('')).toBeUndefined();
    expect(sketchFitNote(words(200))).toContain('fits the page nicely');
    expect(sketchFitNote(words(320))).toContain('a little smaller');
    expect(sketchFitNote(words(500))).toContain('longer than a page holds');
  });
});

function words(count: number): string {
  return Array.from({ length: count }, () => 'word').join(' ');
}

/* -------------------------------------------------------------------------- */

describe('the printed thing', () => {
  it('is four pages, in reading order, each one labelled', () => {
    expect(PROGRAM_PAGES.map((page) => page.number)).toEqual([1, 2, 3, 4]);
    expect(PROGRAM_PAGES[0]?.label).toContain('Page 1');
    expect(PROGRAM_PAGES[0]?.label).toContain('front cover');
    expect(PRINT_SHOP_NOTE).toContain('half fold');
  });

  it('reads as plain text a funeral home can paste into anything', () => {
    const doc = {
      ...emptyProgram(memorial, getPack('secular')),
      lifeSketch: 'She taught fourth grade for thirty-one years.',
      reading: {
        title: 'Do Not Stand at My Grave and Weep',
        text: 'Do not stand at my grave and weep,\nI am not there, I do not sleep.',
        source: 'Attributed to Mary Elizabeth Frye, 1932 — treated as public domain',
      },
      serviceLine: 'Saturday 14 March, 2 pm, at the Meeting House',
    };

    const text = programToText(doc);
    expect(text).toContain('In Loving Memory');
    expect(text).toContain('Ruth Hartley');
    expect(text).toContain('1936 — 2026');
    expect(text).toContain('Saturday 14 March');
    expect(text).toContain('ORDER OF SERVICE');
    expect(text).toContain('Tributes');
    expect(text).toContain('She taught fourth grade');
    expect(text).toContain('DO NOT STAND AT MY GRAVE AND WEEP');
    expect(text).toContain('Mary Elizabeth Frye');
    expect(text).toContain('WITH THANKS');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('knows what is still missing, and says the kind thing about it', () => {
    const doc = emptyProgram(memorial, getPack('secular'));
    const early = programProgress(doc);
    expect(early.ready).toBe(false);
    expect(early.line).toContain('life sketch');

    const withSketch = programProgress({ ...doc, lifeSketch: 'Words.' });
    expect(withSketch.ready).toBe(false);
    expect(withSketch.line).toContain('photograph for the front');

    // A reading is optional — plenty of families do not have one.
    const done = programProgress({ ...doc, lifeSketch: 'Words.', coverAssetId: 'asset-1' });
    expect(done.ready).toBe(true);
    expect(done.line).toContain('Ready to print');
  });

  it('walks the steps forwards and backwards', () => {
    expect(nextProgramStep('cover')).toBe('order');
    expect(nextProgramStep('thanks')).toBeUndefined();
    expect(previousProgramStep('cover')).toBeUndefined();
    expect(previousProgramStep('sketch')).toBe('order');
  });
});
