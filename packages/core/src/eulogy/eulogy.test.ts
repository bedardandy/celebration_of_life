/**
 * The eulogy studio, end to end, against the committed fixtures.
 *
 * The thing being protected here is not a feature, it is a person standing up
 * at a funeral. So the walkthrough checks the two promises the studio makes:
 * a draft is built only from the memories the speaker ticked, and anything in
 * quotation marks is word for word what somebody actually wrote — or the marks
 * come off before anyone ever sees them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AiSchemaError, MOCK_PROVIDER_ID, getProvider, resetMockState } from '@col/ai';
import { PAUSE_MARKER } from '@col/schemas';
import {
  createTestDb,
  insertOne,
  memoryNotes,
  memorials,
  eulogyDrafts,
  listWhere,
  eq,
  type Db,
  type Memorial,
} from '@col/db';
import { saveDocVersion } from '../interview/store';
import { emptyLifeStoryDocument } from '../interview/doc-patch';
import { assembleEulogy, enforceVerbatimQuotes, fullText, matchApprovedMemory } from './assemble';
import { buildEulogyContext, draftEulogy, reviseEulogy, toneOptionsFor } from './draft';
import { pickMemories, selectableMemories } from './memories';
import {
  appendVersion,
  createSpeech,
  countSpeeches,
  latestVersion,
  listSpeeches,
  listVersions,
  notesOf,
  removeSpeech,
  restoreSpeech,
  restoreVersion,
  saveEditedBody,
  saveSetup,
} from './store';
import {
  EMOTION_ALLOWANCE,
  describeSpeechLength,
  estimateReadSeconds,
  formatClock,
  paceParagraphs,
  readAloudSummary,
  withEmotionAllowance,
} from './timer';

let db: Db;
let memorial: Memorial;

const provider = () => getProvider(MOCK_PROVIDER_ID);

const NOTE_ONE =
  'She never let anyone leave that house without something in a container to take home.';
const NOTE_TWO = 'When my dad was ill she drove four hours every Sunday and never once said so.';

function makeMemorial(overrides: Partial<Memorial> = {}): Memorial {
  return insertOne(db, memorials, {
    decedentName: 'Ruth Hartley',
    decedentKnownAs: 'Ruth',
    birthYear: 1936,
    deathYear: 2026,
    traditionSlug: 'secular',
    ...overrides,
  } as Partial<Memorial> as never);
}

function addNote(text: string, authorName: string, approved = true): void {
  insertOne(db, memoryNotes, { memorialId: memorial.id, text, authorName, approved });
}

beforeEach(() => {
  db = createTestDb();
  resetMockState();
  memorial = makeMemorial();
  addNote(NOTE_ONE, 'Her daughter, Anne');
  addNote(NOTE_TWO, 'Her nephew, Tom');
  addNote('A note nobody has approved yet.', 'A neighbour', false);
});

/* -------------------------------------------------------------------------- */

describe('what a speech may be built from', () => {
  it('offers approved memory notes and approved anecdotes, and nothing else', () => {
    const doc = emptyLifeStoryDocument({ fullName: 'Ruth Hartley' });
    doc.chapters.push({
      id: 'the-garden',
      title: 'The garden',
      era: {},
      summary: 'Dahlias, mostly.',
      anecdotes: [
        {
          id: 'a1',
          text: 'She grew dahlias the size of dinner plates.',
          source: 'interview',
          approved: true,
        },
        { id: 'a2', text: 'Something nobody has ticked yet.', source: 'ai-draft', approved: false },
      ],
      people: [],
      openQuestions: [],
    });
    saveDocVersion(db, memorial.id, doc, 'interview');

    const memories = selectableMemories(db, memorial);
    const texts = memories.map((memory) => memory.text);
    expect(texts).toContain(NOTE_ONE);
    expect(texts).toContain('She grew dahlias the size of dinner plates.');
    expect(texts).not.toContain('A note nobody has approved yet.');
    expect(texts).not.toContain('Something nobody has ticked yet.');

    // Ids carry their source, so a note and an anecdote can never collide.
    expect(memories.find((m) => m.text === NOTE_ONE)?.id).toMatch(/^note:/);
    expect(memories.find((m) => m.source === 'story')?.id).toBe('story:the-garden:a1');
  });

  it('picks only what was ticked, in the order it was offered', () => {
    const all = selectableMemories(db, memorial);
    const picked = pickMemories(all, [all[1]?.id ?? '']);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.text).toBe(NOTE_TWO);
  });
});

/* -------------------------------------------------------------------------- */

describe('the verbatim rule', () => {
  const memories = [
    { id: 'note:1', text: NOTE_ONE, attribution: 'Her daughter, Anne' },
    { id: 'note:2', text: NOTE_TWO, attribution: 'Her nephew, Tom' },
  ];

  it('accepts a word-for-word copy, whatever the typography', () => {
    expect(matchApprovedMemory(NOTE_ONE, memories)?.id).toBe('note:1');
    expect(matchApprovedMemory(`  ${NOTE_ONE.toUpperCase()}  `, memories)?.id).toBe('note:1');
    // Curly quotes and stray terminal punctuation are typography, not words.
    expect(matchApprovedMemory(`${NOTE_ONE.replace(/\.$/, '')}`, memories)?.id).toBe('note:1');
  });

  it('refuses anything that has been tidied up, however slightly', () => {
    expect(
      matchApprovedMemory('She never let anyone leave that house empty-handed.', memories),
    ).toBeUndefined();
    expect(matchApprovedMemory('', memories)).toBeUndefined();
  });

  it('takes the quotation marks off a quote nobody actually said', () => {
    const invented = 'She always said the door was never locked.';
    const result = enforceVerbatimQuotes(`Everyone knew it: "${invented}"`, memories);
    expect(result.text).toBe(`Everyone knew it: ${invented}`);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not word for word');
  });

  it('leaves a real quotation exactly as it is', () => {
    const paragraph = `Anne put it best: "${NOTE_ONE}"`;
    const result = enforceVerbatimQuotes(paragraph, memories);
    expect(result.text).toBe(paragraph);
    expect(result.warnings).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('assembly', () => {
  const memories = [{ id: 'note:1', text: NOTE_ONE, attribution: 'Her daughter, Anne' }];

  it('keeps pause markers, but not a speech made of them', () => {
    const assembled = assembleEulogy(
      {
        openingLine: 'Thank you for coming.',
        body: [
          PAUSE_MARKER,
          'One.',
          PAUSE_MARKER,
          'Two.',
          PAUSE_MARKER,
          'Three.',
          PAUSE_MARKER,
          'Four.',
          PAUSE_MARKER,
        ],
        closingLine: 'Thank you.',
        usedMemoryIds: [],
      },
      memories,
    );
    const pauses = assembled.body.split('\n\n').filter((p) => p === PAUSE_MARKER);
    // A leading marker is dropped (nothing to pause after) and the rest are capped.
    expect(pauses.length).toBeLessThanOrEqual(3);
    expect(assembled.body.startsWith(PAUSE_MARKER)).toBe(false);
  });

  it('drops memory ids the speaker never chose, and says so', () => {
    const assembled = assembleEulogy(
      {
        openingLine: 'Thank you for coming.',
        body: ['She fed people.'],
        closingLine: 'Thank you.',
        usedMemoryIds: ['note:1', 'note:1', 'note:99'],
      },
      memories,
    );
    expect(assembled.usedMemoryIds).toEqual(['note:1']);
    expect(assembled.warnings.join(' ')).toContain('had not chosen');
  });

  it('counts the words a person will actually say', () => {
    const assembled = assembleEulogy(
      {
        openingLine: 'One two three.',
        body: [PAUSE_MARKER, 'Four five six seven.'],
        closingLine: 'Eight.',
        usedMemoryIds: [],
      },
      memories,
    );
    expect(assembled.wordCount).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */

describe('drafting against the fixtures', () => {
  function contextFor(
    selected: string[],
    overrides: Partial<Parameters<typeof buildEulogyContext>[2]> = {},
  ) {
    const all = selectableMemories(db, memorial);
    return buildEulogyContext(db, memorial, {
      speakerName: 'Anne Hartley',
      relationship: 'her daughter',
      targetMinutes: 5,
      tone: 'warm-with-laughter',
      memories: pickMemories(all, selected),
      ...overrides,
    });
  }

  it('builds a draft from the chosen memories, quoting them word for word', async () => {
    const all = selectableMemories(db, memorial);
    const chosen = all.map((memory) => memory.id);
    const result = await draftEulogy(contextFor(chosen), { provider: provider() });

    expect(result.warnings).toEqual([]);
    expect(result.body).toContain(NOTE_ONE);
    expect(result.body).toContain(`"${NOTE_ONE}"`);
    // The second memory is retold as narrative rather than quoted — both are
    // allowed, and only one of them is a claim about someone's exact words.
    expect(result.body).toContain(NOTE_TWO);
    expect(result.usedMemoryIds.sort()).toEqual([...chosen].sort());
    expect(result.wordCount).toBeGreaterThan(80);
  });

  it('never leans on a memory the speaker did not tick', async () => {
    const all = selectableMemories(db, memorial);
    const one = all[0]?.id ?? '';
    const result = await draftEulogy(contextFor([one]), { provider: provider() });

    expect(result.usedMemoryIds).toEqual([one]);
    expect(result.body).toContain(NOTE_ONE);
    expect(result.body).not.toContain(NOTE_TWO);
  });

  it('strips the quotation marks off a draft that misquotes, and keeps the sentence', async () => {
    const all = selectableMemories(db, memorial);
    const context = contextFor([all[0]?.id ?? ''], {
      speakerName: 'Marion Hartley',
      relationship: 'her niece',
    });
    const result = await draftEulogy(context, { provider: provider() });

    const invented = 'Nobody has ever gone out of my front door on an empty stomach';
    expect(result.body).toContain(invented);
    expect(result.body).not.toContain(`"${invented}`);
    expect(result.warnings.join(' ')).toContain('not word for word');
    // The real quotation, from the memory she actually ticked, survives intact.
    expect(result.body).toContain(`"${NOTE_ONE}"`);
    // And the memory id the draft invented never reaches the stored speech.
    expect(result.usedMemoryIds).not.toContain('a-memory-that-was-never-chosen');
  });

  it('raises a typed error rather than showing a blank page', async () => {
    const context = contextFor([], { speakerName: 'Wren Hollis' });
    await expect(draftEulogy(context, { provider: provider() })).rejects.toBeInstanceOf(
      AiSchemaError,
    );
  });

  it('revises through the same verbatim rule', async () => {
    const all = selectableMemories(db, memorial);
    const memories = pickMemories(all, [all[0]?.id ?? '']);
    const shorter = await reviseEulogy(
      {
        revision: 'shorter',
        currentBody: 'Something long enough to shorten.',
        memories,
        targetMinutes: 5,
        speakerName: 'Anne Hartley',
      },
      { provider: provider() },
    );
    expect(shorter.body).toContain(`"${NOTE_ONE}"`);
    expect(shorter.warnings).toEqual([]);

    const graveside = await reviseEulogy(
      {
        revision: 'graveside',
        currentBody: 'Something long enough to cut down.',
        memories,
        targetMinutes: 5,
        speakerName: 'Anne Hartley',
      },
      { provider: provider() },
    );
    expect(estimateReadSeconds(fullText(graveside))).toBeLessThan(
      estimateReadSeconds(fullText(shorter)),
    );
  });

  it('offers the tones a tradition reaches for first, without branching on it', () => {
    expect(toneOptionsFor('secular')[0]).toBe('warm-with-laughter');
    expect(toneOptionsFor('catholic')[0]).toBe('faithful');
    expect(toneOptionsFor('jewish')[0]).toBe('quiet-and-simple');
    // An unknown slug is a shrug, not a crash.
    expect(toneOptionsFor('klingon')).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */

describe('versions', () => {
  it('appends rather than overwrites, and can always go back', async () => {
    const speech = createSpeech(db, {
      memorialId: memorial.id,
      speakerName: 'Anne Hartley',
      relationship: 'her daughter',
    });
    expect(speech.version).toBe(1);
    expect(speech.status).toBe('setup');

    const all = selectableMemories(db, memorial);
    saveSetup(db, speech.speechId, { selectedMemoryIds: [all[0]?.id ?? ''] });
    // Setup writes in place: there are no words to protect yet.
    expect(listVersions(db, speech.speechId)).toHaveLength(1);

    const drafted = await draftEulogy(
      buildEulogyContext(db, memorial, {
        speakerName: 'Anne Hartley',
        relationship: 'her daughter',
        targetMinutes: 5,
        tone: 'warm-with-laughter',
        memories: pickMemories(all, [all[0]?.id ?? '']),
      }),
      { provider: provider() },
    );

    const first = appendVersion(db, {
      speechId: speech.speechId,
      from: speech,
      body: fullText(drafted),
      createdBy: 'ai',
      note: 'First draft',
      status: 'draft',
    });
    expect(first.version).toBe(2);

    // A hand edit on top of an AI version appends: the AI version stays intact.
    const edited = saveEditedBody(db, speech.speechId, `${first.body}\n\nAnd one more thing.`);
    expect(edited?.version).toBe(3);
    expect(latestVersion(db, speech.speechId)?.body).toContain('And one more thing.');

    // Further typing updates that same hand-edited row rather than flooding history.
    saveEditedBody(db, speech.speechId, `${first.body}\n\nAnd one more thing, really.`);
    expect(listVersions(db, speech.speechId)).toHaveLength(3);

    // Going back is itself a new version, so nothing is ever destroyed.
    const restored = restoreVersion(db, first.id);
    expect(restored?.version).toBe(4);
    expect(restored?.body).toBe(first.body);
    expect(listVersions(db, speech.speechId)).toHaveLength(4);
    expect(listVersions(db, speech.speechId).map((row) => row.version)).toEqual([4, 3, 2, 1]);
  });

  it('keeps the graveside version alongside the speech, not instead of it', () => {
    const speech = createSpeech(db, { memorialId: memorial.id, speakerName: 'Anne' });
    const full = appendVersion(db, {
      speechId: speech.speechId,
      from: speech,
      body: 'The whole speech.',
      createdBy: 'ai',
      note: 'First draft',
      status: 'draft',
    });
    appendVersion(db, {
      speechId: speech.speechId,
      from: full,
      body: 'The short one.',
      createdBy: 'ai',
      note: 'Graveside version',
      variant: 'graveside',
      status: 'draft',
    });

    expect(latestVersion(db, speech.speechId)?.body).toBe('The whole speech.');
    expect(latestVersion(db, speech.speechId, 'graveside')?.body).toBe('The short one.');

    const speeches = listSpeeches(db, memorial.id);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]?.current.body).toBe('The whole speech.');
    expect(speeches[0]?.graveside?.body).toBe('The short one.');
  });

  it('carries the setup forward and keeps several speakers apart', () => {
    const anne = createSpeech(db, {
      memorialId: memorial.id,
      speakerName: 'Anne Hartley',
      relationship: 'her daughter',
      targetMinutes: 7,
      tone: 'quiet-and-simple',
    });
    const tom = createSpeech(db, { memorialId: memorial.id, speakerName: 'Tom Hartley' });

    appendVersion(db, {
      speechId: anne.speechId,
      from: anne,
      body: 'Annes words.',
      createdBy: 'ai',
      note: 'First draft',
    });

    const current = latestVersion(db, anne.speechId);
    expect(current?.targetMinutes).toBe(7);
    expect(current?.tone).toBe('quiet-and-simple');
    expect(current?.relationship).toBe('her daughter');

    expect(listSpeeches(db, memorial.id).map((s) => s.speechId)).toEqual([
      anne.speechId,
      tom.speechId,
    ]);
    expect(countSpeeches(db, memorial.id)).toEqual({ started: 2, drafted: 1 });
  });

  it('removes a speech the way everything else is removed: undoably', () => {
    const speech = createSpeech(db, { memorialId: memorial.id, speakerName: 'Anne' });
    appendVersion(db, {
      speechId: speech.speechId,
      from: speech,
      body: 'Words.',
      createdBy: 'organizer',
      note: 'Edited by hand',
    });

    expect(removeSpeech(db, speech.speechId)).toBe(2);
    expect(listSpeeches(db, memorial.id)).toHaveLength(0);
    // The rows are still there, tombstoned, which is what makes undo real.
    expect(listWhere(db, eulogyDrafts, eq(eulogyDrafts.speechId, speech.speechId))).toHaveLength(2);

    expect(restoreSpeech(db, speech.speechId)).toBe(2);
    expect(listSpeeches(db, memorial.id)).toHaveLength(1);
  });

  it('remembers which memories were ticked, across versions', () => {
    const speech = createSpeech(db, { memorialId: memorial.id, speakerName: 'Anne' });
    const all = selectableMemories(db, memorial);
    const chosen = [all[0]?.id ?? ''];
    saveSetup(db, speech.speechId, { selectedMemoryIds: chosen });

    const current = latestVersion(db, speech.speechId);
    expect(notesOf(current).selectedMemoryIds).toEqual(chosen);

    appendVersion(db, {
      speechId: speech.speechId,
      from: current as NonNullable<typeof current>,
      body: 'Words.',
      createdBy: 'ai',
      note: 'First draft',
    });
    expect(notesOf(latestVersion(db, speech.speechId)).selectedMemoryIds).toEqual(chosen);
  });
});

/* -------------------------------------------------------------------------- */

describe('the read-aloud timer', () => {
  it('adds a quarter for emotion, because everyone slows down', () => {
    expect(EMOTION_ALLOWANCE).toBe(1.25);
    expect(withEmotionAllowance(240)).toBe(300);
    expect(formatClock(withEmotionAllowance(250))).toBe('5:13');
  });

  it('says the two numbers a person can act on', () => {
    const summary = readAloudSummary(250, 5);
    expect(summary.elapsedLabel).toBe('4:10');
    expect(summary.plannedLabel).toBe('5:13');
    expect(summary.line).toBe('Your read: 4:10. On the day, plan for about 5:13.');
    expect(summary.verdict).toContain('close to the 5 minutes');
  });

  it('never tells anyone off for running long', () => {
    const long = readAloudSummary(600, 5);
    expect(long.verdict).toContain('past the 5');
    expect(long.verdict).not.toMatch(/too long|cut it down|shorten it now/i);

    const short = readAloudSummary(120, 5);
    expect(short.verdict).toContain('Comfortably inside');
  });

  it('estimates a read from the words, and gives a pause its due', () => {
    const words = Array.from({ length: 130 }, () => 'word').join(' ');
    expect(estimateReadSeconds(words)).toBeCloseTo(60, 5);
    expect(estimateReadSeconds(`${words}\n\n${PAUSE_MARKER}`)).toBeCloseTo(62.5, 5);
    expect(describeSpeechLength(words)).toBe('about 1 minute');
  });

  it('paces paragraph by paragraph, so nothing is scrolled past', () => {
    const text = ['One two three four.', PAUSE_MARKER, 'Five six.'].join('\n\n');
    const paced = paceParagraphs(text);
    expect(paced).toHaveLength(3);
    expect(paced[1]?.pause).toBe(true);
    expect(paced[1]?.startSec).toBeCloseTo(paced[0]?.durationSec ?? 0, 5);
    expect(paced[2]?.startSec).toBeGreaterThan(paced[1]?.startSec ?? 0);
  });
});
