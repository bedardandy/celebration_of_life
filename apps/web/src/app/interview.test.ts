/**
 * The interview journey, headless.
 *
 * An organiser lands on the story page, begins, answers, half-types an answer
 * and closes the tab, comes back to find it exactly where it was, skips a
 * question, keeps one memory and rewrites another, and stops for the night. If
 * any of that stops working, someone loses an evening they cannot spare, so it
 * is checked every run.
 *
 * The mock provider is forced by NODE_ENV=test, so this never touches a model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-interview-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'interview.db')}`;
process.env['SESSION_SECRET'] = 'interview-test-secret';
process.env['APP_BASE_URL'] = 'http://localhost:3000';

vi.mock('next/headers', async () => {
  const { nextHeadersMock } = await import('@/test/next-stubs');
  return nextHeadersMock();
});
vi.mock('next/cache', async () => {
  const { nextCacheMock } = await import('@/test/next-stubs');
  return nextCacheMock();
});

const { cookieJar, captureRedirect } = await import('@/test/next-stubs');
const { db } = await import('@/server/db');
const { createMemorialAction } = await import('./new/actions');
const {
  anecdoteAction,
  answerAction,
  beginInterviewAction,
  pauseInterviewAction,
  saveDraftAction,
} = await import('./m/[memorialId]/interview/actions');
const { analyzePhotosAction } = await import('./m/[memorialId]/story/actions');
const { analyzableAssetIds } = await import('./m/[memorialId]/story/photos');
const {
  DevConsoleTransport,
  setMailTransport,
  computeChecklist,
  currentDoc,
  readInterview,
  subjectOf,
} = await import('@col/core');
const { getById, insertOne, listWhere, jobs, mediaAssets, memorials } = await import('@col/db');
const { resetMockState } = await import('@col/ai');

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeAll(() => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
});

beforeEach(() => {
  cookieJar.clear();
  resetMockState();
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function signedInMemorial(): Promise<string> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: 'Ruth Hartley',
        organizerName: 'Anne Hartley',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  return destination.split('/')[2] as string;
}

function memorialRow(memorialId: string) {
  const row = getById(db(), memorials, memorialId);
  if (!row) throw new Error('memorial vanished');
  return row;
}

function state(memorialId: string) {
  return readInterview(db(), memorialRow(memorialId));
}

const ANSWERS = [
  'She was born in 1936 in a farmhouse outside Bellwood, Ohio. Her mother kept bees.',
  'She walked to a one-room school, two miles each way.',
  'Thirty-one years of fourth grade at Pinecrest.',
];

/* -------------------------------------------------------------------------- */

describe('beginning', () => {
  it('asks the first question without any waiting', async () => {
    const memorialId = await signedInMemorial();
    expect(state(memorialId)).toBeUndefined();

    await captureRedirect(() => beginInterviewAction(form({ memorialId })));

    const started = state(memorialId);
    expect(started?.question.text).toContain('Ruth');
    expect(started?.question.promptSlug).toBe('beginnings');
    expect(started?.draft).toBe('');
  });

  it('does not start a second interview when the button is pressed twice', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const first = state(memorialId)?.session.id;
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    expect(state(memorialId)?.session.id).toBe(first);
  });
});

describe('answering', () => {
  it('moves to the next question and fills in the story', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;

    const result = await answerAction({ memorialId, sessionId, text: ANSWERS[0] as string });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question).toContain('girl');
      expect(result.chapters).toBe(1);
    }

    const doc = currentDoc(db(), memorialId, subjectOf(memorialRow(memorialId))).doc;
    expect(doc.chapters[0]?.title).toContain('Bellwood');
    expect(doc.chapters[0]?.anecdotes[0]?.approved).toBe(false);
  });

  it('keeps a half-typed answer through a closed tab', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;

    await saveDraftAction({ memorialId, sessionId, text: 'She was born in a farmh' });
    cookieJar.clear();

    // …and back again, with the same link.
    const returned = readInterview(db(), memorialRow(memorialId));
    expect(returned?.draft).toBe('She was born in a farmh');
    expect(returned?.answered).toBe(0);
  });

  it('refuses a draft aimed at a session that has moved on', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));

    await saveDraftAction({ memorialId, sessionId: 'not-this-session', text: 'nonsense' });
    expect(state(memorialId)?.draft).toBe('');
  });

  it('treats a skip as an answer and moves on without comment', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;

    const result = await answerAction({ memorialId, sessionId, text: '', skipped: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.question).not.toContain('Ruth’s life begin');
    expect(state(memorialId)?.answered).toBe(1);
  });

  it('says one calm sentence when the model cannot be understood', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;

    const result = await answerAction({
      memorialId,
      sessionId,
      text: 'I truly cannot say tonight.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/nothing you wrote was lost/i);
      expect(result.message).not.toMatch(/schema|json|stack|provider/i);
    }
    // Their words are still there, and the question has not moved.
    const after = state(memorialId);
    expect(after?.draft).toBe('I truly cannot say tonight.');
    expect(after?.question.promptSlug).toBe('beginnings');
  });
});

describe('stopping and coming back', () => {
  it('pauses to the story page and resumes at the same question', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;
    await answerAction({ memorialId, sessionId, text: ANSWERS[0] as string });
    const question = state(memorialId)?.question.text;

    const destination = await captureRedirect(() =>
      pauseInterviewAction(form({ memorialId, sessionId })),
    );
    expect(destination).toBe(`/m/${memorialId}/story`);
    expect(readInterview(db(), memorialRow(memorialId))).toBeUndefined();

    const resumed = await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    expect(resumed).toBe(`/m/${memorialId}/interview`);
    // Same session, same pending question.
    expect(state(memorialId)?.session.id).toBe(sessionId);
    expect(state(memorialId)?.question.text).toBe(question);
  });
});

describe('deciding what stays in', () => {
  it('keeps, rewrites and removes a memory, each as a new version', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;
    for (const text of ANSWERS) await answerAction({ memorialId, sessionId, text });

    const subject = subjectOf(memorialRow(memorialId));
    const before = currentDoc(db(), memorialId, subject);
    const chapter = before.doc.chapters[0];
    const anecdote = chapter?.anecdotes[0];
    expect(anecdote?.approved).toBe(false);

    await captureRedirect(() =>
      anecdoteAction(
        form({
          memorialId,
          chapterId: chapter?.id as string,
          anecdoteId: anecdote?.id as string,
          action: 'approve',
          returnTo: `/m/${memorialId}/story`,
        }),
      ),
    );
    let now = currentDoc(db(), memorialId, subject);
    expect(now.doc.chapters[0]?.anecdotes[0]?.approved).toBe(true);
    expect(now.version).toBe(before.version + 1);

    await captureRedirect(() =>
      anecdoteAction(
        form({
          memorialId,
          chapterId: chapter?.id as string,
          anecdoteId: anecdote?.id as string,
          action: 'edit',
          text: 'She was never once stung, which she put down to good manners.',
          returnTo: `/m/${memorialId}/story`,
        }),
      ),
    );
    now = currentDoc(db(), memorialId, subject);
    expect(now.doc.chapters[0]?.anecdotes[0]).toMatchObject({
      text: 'She was never once stung, which she put down to good manners.',
      source: 'organizer',
      approved: true,
    });

    await captureRedirect(() =>
      anecdoteAction(
        form({
          memorialId,
          chapterId: chapter?.id as string,
          anecdoteId: anecdote?.id as string,
          action: 'remove',
          returnTo: `/m/${memorialId}/story`,
        }),
      ),
    );
    now = currentDoc(db(), memorialId, subject);
    expect(now.doc.chapters[0]?.anecdotes.find((a) => a.id === anecdote?.id)).toBeUndefined();
    expect(now.version).toBe(before.version + 3);
  });
});

describe('the dashboard story card', () => {
  it('counts chapters once the interview has produced some', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => beginInterviewAction(form({ memorialId })));
    const sessionId = state(memorialId)?.session.id as string;
    for (const text of ANSWERS) await answerAction({ memorialId, sessionId, text });

    const doc = currentDoc(db(), memorialId, subjectOf(memorialRow(memorialId))).doc;
    const checklist = computeChecklist(memorialRow(memorialId), {
      photos: 0,
      memories: 0,
      storyChapters: doc.chapters.length,
    });
    const card = checklist.cards.find((c) => c.id === 'story');
    expect(card?.statusLine).toMatch(/Their story is taking shape — \d+ chapters so far/);
    expect(card?.href).toBe(`/m/${memorialId}/story`);
  });
});

describe('looking through the photographs', () => {
  it('only ever happens because somebody pressed the button', async () => {
    const memorialId = await signedInMemorial();
    insertOne(db(), mediaAssets, {
      memorialId,
      mime: 'image/jpeg',
      blobKey: `memorial/${memorialId}/original/a.jpg`,
    } as never);

    // Nothing queued until it is asked for.
    const queued = () =>
      listWhere(db(), jobs).filter(
        (job) => job.type === 'analyze-photo-batch' && job.memorialId === memorialId,
      );
    expect(queued()).toHaveLength(0);
    expect(analyzableAssetIds(db(), memorialId)).toHaveLength(1);

    const destination = await captureRedirect(() => analyzePhotosAction(form({ memorialId })));
    expect(destination).toBe(`/m/${memorialId}/story?analysis=started`);
    expect(queued()).toHaveLength(1);
    expect((queued()[0]?.payload as { assetIds: string[] }).assetIds).toHaveLength(1);
  });

  it('queues nothing when there is nothing to look at', async () => {
    const memorialId = await signedInMemorial();
    await captureRedirect(() => analyzePhotosAction(form({ memorialId })));
    expect(
      listWhere(db(), jobs).filter(
        (job) => job.type === 'analyze-photo-batch' && job.memorialId === memorialId,
      ),
    ).toHaveLength(0);
  });
});
