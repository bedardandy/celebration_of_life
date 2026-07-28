/**
 * The interview, end to end, against the committed fixtures.
 *
 * This is the test that says the feature works: ten answers go in, a coherent
 * multi-chapter life story comes out, every anecdote is unapproved until someone
 * says otherwise, and every revision is still on disk. It is deliberately a
 * walkthrough rather than a set of unit tests, because the thing that breaks in
 * an interview is never one function — it is the fifth turn forgetting the
 * second.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AiSchemaError,
  MOCK_PROVIDER_ID,
  friendlyAiMessage,
  getProvider,
  resetMockState,
} from '@col/ai';
import { LifeStoryDocumentSchema } from '@col/schemas';
import { createTestDb, insertOne, memoryNotes, memorials, type Db, type Memorial } from '@col/db';
import {
  applyAnecdoteAction,
  buildTurnMessages,
  pauseInterview,
  readInterview,
  resumeInterview,
  saveDraft,
  startInterview,
  submitAnswer,
} from './engine';
import { activeSession, listDocVersions, listTurns } from './store';

let db: Db;
let memorial: Memorial;

function makeMemorial(overrides: Partial<Memorial> = {}): Memorial {
  return insertOne(db, memorials, {
    decedentName: 'Ruth Hartley',
    decedentKnownAs: 'Ruth',
    birthYear: 1936,
    deathYear: 2026,
    traditionSlug: 'secular',
    organizerRelationship: 'granddaughter',
    ...overrides,
  } as Partial<Memorial> as never);
}

beforeEach(() => {
  db = createTestDb();
  resetMockState();
  memorial = makeMemorial();
});

const provider = () => getProvider(MOCK_PROVIDER_ID);

/**
 * The ten answers a granddaughter might actually give. Each one contains the
 * phrase its fixture matches on; turn 7 is a skip, and turn 10 is the fixture
 * that returns broken JSON once before it returns the real answer.
 */
const ANSWERS: { text: string; skipped?: boolean }[] = [
  { text: 'She was born in 1936 in a farmhouse outside Bellwood, Ohio. Her mother kept bees.' },
  {
    text: 'She walked to a one-room school, two miles each way, and decided at nine she would teach.',
  },
  { text: 'Thirty-one years of fourth grade at Pinecrest. She kept a photo of every class.' },
  { text: 'She married Walter in 1958. Two children — Susan and David.' },
  { text: 'The dahlias. The whole back garden went to them.' },
  { text: "Well, we'll see. That was her answer to everything." },
  { text: '', skipped: true },
  { text: 'Kneeling in the dirt in August with the kitchen radio on. That is how I see her.' },
  { text: 'She was not a churchgoer. She believed in showing up.' },
  { text: 'The recipe box on the shelf. She wrote notes in the margins of every card.' },
];

async function walkTheInterview(): Promise<Awaited<ReturnType<typeof submitAnswer>>> {
  const started = startInterview(db, memorial);
  let last!: Awaited<ReturnType<typeof submitAnswer>>;
  for (const answer of ANSWERS) {
    last = await submitAnswer(db, {
      memorial,
      sessionId: started.session.id,
      text: answer.text,
      ...(answer.skipped ? { skipped: true } : {}),
      provider: provider(),
    });
  }
  return last;
}

/* -------------------------------------------------------------------------- */

describe('starting an interview', () => {
  it('asks the first question without calling a model at all', () => {
    const state = startInterview(db, memorial);
    expect(state.question.text).toContain('Ruth');
    expect(state.question.promptSlug).toBe('beginnings');
    expect(state.answered).toBe(0);
    expect(state.draft).toBe('');
  });

  it('is idempotent, because tired people double-tap buttons', () => {
    const first = startInterview(db, memorial);
    const second = startInterview(db, memorial);
    expect(second.session.id).toBe(first.session.id);
    expect(listTurns(db, first.session.id)).toHaveLength(2);
  });

  it('opens a document immediately, so no screen ever has nothing to show', () => {
    startInterview(db, memorial);
    const versions = listDocVersions(db, memorial.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.doc.subject.fullName).toBe('Ruth Hartley');
  });
});

describe('the draft answer', () => {
  it('survives a closed tab without any Save button', () => {
    const state = startInterview(db, memorial);
    saveDraft(db, state.session.id, 'She was born in a farm');
    saveDraft(db, state.session.id, 'She was born in a farmhouse outside Bellwood');

    const resumed = readInterview(db, memorial);
    expect(resumed?.draft).toBe('She was born in a farmhouse outside Bellwood');
    // Still unanswered — a draft is not a turn.
    expect(resumed?.answered).toBe(0);
  });

  it('brings the pending question back on the way in', async () => {
    const state = startInterview(db, memorial);
    await submitAnswer(db, {
      memorial,
      sessionId: state.session.id,
      text: ANSWERS[0]!.text,
      provider: provider(),
    });
    pauseInterview(db, state.session.id);

    const resumed = resumeInterview(db, memorial);
    expect(resumed.session.id).toBe(state.session.id);
    expect(resumed.question.text).toContain('girl');
    expect(resumed.answered).toBe(1);
  });
});

describe('a ten-turn interview', () => {
  it('produces a coherent, schema-valid, multi-chapter life story', async () => {
    const final = await walkTheInterview();

    const parsed = LifeStoryDocumentSchema.safeParse(final.doc);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);

    expect(final.doc.chapters.length).toBeGreaterThanOrEqual(2);
    expect(final.doc.chapters.map((c) => c.id)).toEqual(
      expect.arrayContaining(['early-years', 'the-classroom', 'the-garden']),
    );
    expect(final.doc.themes).toEqual(
      expect.arrayContaining(['Growing things', 'Teaching', 'Family']),
    );

    // Real content, in her own words, not a placeholder.
    const summaries = final.doc.chapters.map((c) => c.summary).join(' ');
    expect(summaries).toContain('Bellwood');
    expect(summaries).toContain('Pinecrest');
  });

  it('leaves every anecdote unapproved until a person says otherwise', async () => {
    const final = await walkTheInterview();
    const anecdotes = final.doc.chapters.flatMap((c) => c.anecdotes);
    expect(anecdotes.length).toBeGreaterThanOrEqual(5);
    expect(anecdotes.every((a) => a.approved === false)).toBe(true);
    expect(final.progress.pendingAnecdotes).toBe(anecdotes.length);
  });

  it('writes each revision as a new version, never overwriting one', async () => {
    await walkTheInterview();
    const versions = listDocVersions(db, memorial.id).map((row) => row.version);
    // Descending, dense, starting at 1: append-only with nothing reused.
    expect(versions[versions.length - 1]).toBe(1);
    expect(versions[0]).toBe(versions.length);
    expect(new Set(versions).size).toBe(versions.length);

    // And the first version really is still the empty one.
    const oldest = listDocVersions(db, memorial.id).at(-1);
    expect(oldest?.doc.chapters).toHaveLength(0);
  });

  it('treats a skip as an answer and does not ask again', async () => {
    const started = startInterview(db, memorial);
    for (const answer of ANSWERS.slice(0, 7)) {
      await submitAnswer(db, {
        memorial,
        sessionId: started.session.id,
        text: answer.text,
        ...(answer.skipped ? { skipped: true } : {}),
        provider: provider(),
      });
    }
    const turns = listTurns(db, started.session.id);
    const skipped = turns.filter((turn) => turn.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.text).toBe('');

    // The question after the skip moves on rather than repeating it.
    const state = readInterview(db, memorial);
    expect(state?.question.promptSlug).toBe('joy');
  });

  it('goes through the repair loop on the way, without the caller noticing', async () => {
    const final = await walkTheInterview();
    // Turn 10's fixture returns broken JSON once. If the repair loop were not
    // working, this walkthrough would have thrown four turns ago.
    expect(final.doc.chapters.map((c) => c.id)).toContain('later-years');
    expect(final.doc.chapters.find((c) => c.id === 'later-years')?.summary).toContain('recipe box');
  });

  it('records the coverage note the interview offers', async () => {
    const final = await walkTheInterview();
    expect(final.turn.coverage.sufficientForDraft).toBe(true);
    expect(final.coverageNote).toContain('draft');
  });
});

describe('what the model is told', () => {
  it('carries the tone rules, the tradition adjustments and the story so far', async () => {
    const started = startInterview(db, memorial);
    await submitAnswer(db, {
      memorial,
      sessionId: started.session.id,
      text: ANSWERS[0]!.text,
      provider: provider(),
    });

    const messages = buildTurnMessages({
      db,
      memorial,
      session: activeSession(db, memorial.id)!,
      doc: readInterview(db, memorial)!.doc,
      question: 'What was she like as a girl?',
      answer: 'Quiet, and stubborn about it.',
      skipped: false,
    });

    const system = String(messages[0]?.content);
    expect(messages[0]?.role).toBe('system');
    expect(system).toContain('ONE question at a time');
    expect(system).toContain('We can set that aside.');
    expect(system).toContain('Never invent a fact');
    expect(system).toContain('Ruth');
    expect(system).toContain('granddaughter');
    // From the secular tradition pack's interviewAdjustments.
    expect(system).toContain('faith-and-belief');
    expect(system).toContain('rather than about religion');

    const docSummary = String(messages[1]?.content);
    expect(docSummary).toContain('[early-years]');

    const closing = String(messages[messages.length - 1]?.content);
    expect(closing).toContain('Quiet, and stubborn about it.');
  });

  it('feeds in what other relatives have already written', () => {
    insertOne(db, memoryNotes, {
      memorialId: memorial.id,
      authorName: 'Cousin Marie',
      text: 'She taught me to prick out seedlings on her kitchen table.',
    });
    const started = startInterview(db, memorial);

    const system = String(
      buildTurnMessages({
        db,
        memorial,
        session: started.session,
        doc: started.doc,
        question: 'Where did her life begin?',
        answer: 'On a farm.',
        skipped: false,
      })[0]?.content,
    );
    expect(system).toContain('Cousin Marie');
    expect(system).toContain('prick out seedlings');
    expect(system).toContain('never repeat one back');
  });

  it('says plainly that a question was skipped, and not to comment on it', () => {
    const started = startInterview(db, memorial);
    const closing = String(
      buildTurnMessages({
        db,
        memorial,
        session: started.session,
        doc: started.doc,
        question: 'Was there a hard stretch?',
        answer: '',
        skipped: true,
      }).at(-1)?.content,
    );
    expect(closing).toContain('They skipped this question');
    expect(closing).toContain('do not comment on the skip');
  });
});

describe('when the model cannot be understood', () => {
  it('raises a typed error and loses nothing the person typed', async () => {
    const started = startInterview(db, memorial);
    const answer = 'I truly cannot say. It is all a bit much tonight.';

    await expect(
      submitAnswer(db, {
        memorial,
        sessionId: started.session.id,
        text: answer,
        provider: provider(),
      }),
    ).rejects.toBeInstanceOf(AiSchemaError);

    // Their words are already on the row, written before the call went out.
    const turns = listTurns(db, started.session.id);
    expect(turns.at(-1)?.text).toBe(answer);
    // And no half-written document version was appended.
    expect(listDocVersions(db, memorial.id)).toHaveLength(1);
  });

  it('has a plain sentence for the screen, with no technical detail in it', async () => {
    const started = startInterview(db, memorial);
    try {
      await submitAnswer(db, {
        memorial,
        sessionId: started.session.id,
        text: 'I truly cannot say.',
        provider: provider(),
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = friendlyAiMessage(error);
      expect(message).not.toMatch(/schema|json|mock|provider/i);
      expect(message).toMatch(/nothing you wrote was lost/i);
    }
  });

  it('refuses a session id belonging to somebody else', async () => {
    const other = makeMemorial({ decedentName: 'Someone Else' } as Partial<Memorial>);
    const started = startInterview(db, other);
    await expect(
      submitAnswer(db, {
        memorial,
        sessionId: started.session.id,
        text: 'hello',
        provider: provider(),
      }),
    ).rejects.toThrow(/does not belong to memorial/);
  });
});

describe('approving what the interview drafted', () => {
  it('approves, edits and removes, each as a new organizer version', async () => {
    const final = await walkTheInterview();
    const chapter = final.doc.chapters[0]!;
    const anecdote = chapter.anecdotes[0]!;
    const before = listDocVersions(db, memorial.id).length;

    const approved = applyAnecdoteAction(db, {
      memorial,
      chapterId: chapter.id,
      anecdoteId: anecdote.id,
      action: 'approve',
    });
    expect(approved.changed).toBe(true);
    expect(approved.doc.chapters[0]?.anecdotes[0]?.approved).toBe(true);
    expect(listDocVersions(db, memorial.id)[0]?.createdBy).toBe('organizer');

    const edited = applyAnecdoteAction(db, {
      memorial,
      chapterId: chapter.id,
      anecdoteId: anecdote.id,
      action: 'edit',
      text: 'She was never once stung, which she put down to good manners.',
    });
    expect(edited.doc.chapters[0]?.anecdotes[0]).toMatchObject({
      source: 'organizer',
      approved: true,
    });

    const removed = applyAnecdoteAction(db, {
      memorial,
      chapterId: chapter.id,
      anecdoteId: anecdote.id,
      action: 'remove',
    });
    expect(removed.doc.chapters[0]?.anecdotes.find((a) => a.id === anecdote.id)).toBeUndefined();

    expect(listDocVersions(db, memorial.id).length).toBe(before + 3);
  });

  it('does nothing, quietly, for an anecdote that is already gone', async () => {
    await walkTheInterview();
    const before = listDocVersions(db, memorial.id).length;
    const result = applyAnecdoteAction(db, {
      memorial,
      chapterId: 'early-years',
      anecdoteId: 'not-a-real-id',
      action: 'approve',
    });
    expect(result.changed).toBe(false);
    expect(listDocVersions(db, memorial.id).length).toBe(before);
  });
});
