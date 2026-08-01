/**
 * The eulogy studio and the printed program, headless.
 *
 * A daughter sets up a speech, ticks two memories, gets a first draft, shortens
 * it, changes her mind and puts the longer one back, makes a graveside version,
 * and prints it large. Then the family builds the program: the order of service
 * arrives already filled in from their tradition, the life sketch is drafted
 * from the story they told, and the whole thing comes out as plain text a
 * funeral home can paste into an email.
 *
 * Two of these tests are the ones that matter. One proves a draft only ever
 * leans on the memories the speaker ticked. The other proves that when the model
 * puts quotation marks around a sentence nobody actually said, the marks come
 * off before anybody reads it out at a funeral.
 *
 * The mock provider is forced by NODE_ENV=test, so none of this touches a model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-speeches-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'speeches.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'speeches-test-secret';
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
const { answerStepAction } = await import('./m/[memorialId]/intake/actions');
const {
  draftSpeechAction,
  restoreVersionAction,
  reviseSpeechAction,
  removeSpeechAction,
  restoreSpeechAction,
  saveSetupStepAction,
  saveSpeechBodyAction,
  startSpeechAction,
} = await import('./m/[memorialId]/speeches/actions');
const {
  continueProgramAction,
  draftSketchAction,
  orderItemAction,
  saveReadingAction,
  saveThanksAction,
} = await import('./m/[memorialId]/program/actions');

const SpeechesPage = (await import('./m/[memorialId]/speeches/page')).default;
const SpeechPage = (await import('./m/[memorialId]/speeches/[speechId]/page')).default;
const SpeechSetupPage = (await import('./m/[memorialId]/speeches/[speechId]/setup/[step]/page'))
  .default;
const SpeechPrintPage = (await import('./m/[memorialId]/speeches/[speechId]/print/page')).default;
const ProgramPage = (await import('./m/[memorialId]/program/page')).default;
const ProgramStepPage = (await import('./m/[memorialId]/program/[step]/page')).default;
const ProgramPrintPage = (await import('./m/[memorialId]/program/print/page')).default;
const DashboardPage = (await import('./m/[memorialId]/page')).default;
const { GET: getProgramText } = await import('./api/program/[memorialId]/program.txt/route');

const {
  DevConsoleTransport,
  currentProgram,
  emptyLifeStoryDocument,
  latestVersion,
  listSpeeches,
  listVersions,
  notesOf,
  saveDocVersion,
  selectableMemories,
  setMailTransport,
} = await import('@col/core');
const { getById, insertOne, memorials, memoryNotes } = await import('@col/db');
const { resetMockState } = await import('@col/ai');

beforeAll(() => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
});

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  cookieJar.clear();
  resetMockState();
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const NOTE_ONE =
  'She never let anyone leave that house without something in a container to take home.';
const NOTE_TWO = 'When my dad was ill she drove four hours every Sunday and never once said so.';

function form(values: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}

async function signedInMemorial(tradition = 'secular'): Promise<string> {
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
  const memorialId = destination.split('/')[2] as string;
  await captureRedirect(() =>
    answerStepAction(form({ memorialId, step: 'tradition', value: tradition })),
  );
  return memorialId;
}

function addMemories(memorialId: string): void {
  insertOne(db(), memoryNotes, {
    memorialId,
    authorName: 'Her daughter, Anne',
    text: NOTE_ONE,
    approved: true,
  } as never);
  insertOne(db(), memoryNotes, {
    memorialId,
    authorName: 'Her nephew, Tom',
    text: NOTE_TWO,
    approved: true,
  } as never);
}

function addStory(memorialId: string): void {
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
  saveDocVersion(db(), memorialId, doc, 'interview');
}

/** Walks the four setup screens the way a person would. */
async function setUpSpeech(
  memorialId: string,
  options: {
    speakerName?: string;
    relationship?: string;
    targetMinutes?: string;
    tone?: string;
    memoryIds?: string[];
  } = {},
): Promise<string> {
  const destination = await captureRedirect(() => startSpeechAction(form({ memorialId })));
  const speechId = destination.split('/')[4] as string;

  await captureRedirect(() =>
    saveSetupStepAction(
      form({
        memorialId,
        speechId,
        step: 'speaker',
        speakerName: options.speakerName ?? 'Anne Hartley',
        relationship: options.relationship ?? 'her daughter',
      }),
    ),
  );
  await captureRedirect(() =>
    saveSetupStepAction(
      form({ memorialId, speechId, step: 'length', targetMinutes: options.targetMinutes ?? '5' }),
    ),
  );
  await captureRedirect(() =>
    saveSetupStepAction(
      form({ memorialId, speechId, step: 'tone', tone: options.tone ?? 'warm-with-laughter' }),
    ),
  );
  await captureRedirect(() =>
    saveSetupStepAction(
      form({
        memorialId,
        speechId,
        step: 'memories',
        memoryId: options.memoryIds ?? memoryIdsFor(memorialId),
      }),
    ),
  );
  return speechId;
}

function memoryIdsFor(memorialId: string): string[] {
  const memorial = getById(db(), memorials, memorialId);
  if (!memorial) throw new Error('memorial vanished');
  return selectableMemories(db(), memorial).map((memory) => memory.id);
}

/* -------------------------------------------------------------------------- */
/* rendering server components without a browser                               */
/* -------------------------------------------------------------------------- */

type Node = ReactElement | string | number | null | undefined | boolean | Node[];

function isElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

const NOT_TEXT = new Set([
  'className',
  'style',
  'src',
  'id',
  'key',
  'type',
  'name',
  'action',
  'width',
  'height',
  'loading',
  'htmlFor',
  'list',
]);

const CLIENT_COMPONENTS = new Set([
  'DraftTools',
  'ReadAloudTimer',
  'RemoveSpeech',
  'SketchEditor',
  'SavedIndicator',
  'RemoveMemorial',
  'RenderWatch',
  'PreviewPlayer',
]);

/** Every string of text a server component put on the page, props included. */
function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';

  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name =
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) return textOf(rendered as Node);
      } catch {
        // A component that needs a browser contributes nothing, honestly.
      }
    }
  }

  return Object.entries(props)
    .filter(([key]) => !NOT_TEXT.has(key))
    .map(([, value]) => textOf(value as Node))
    .join(' ');
}

const params = (memorialId: string) => Promise.resolve({ memorialId });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

/* -------------------------------------------------------------------------- */
/* the speech                                                                  */
/* -------------------------------------------------------------------------- */

describe('setting a speech up', () => {
  it('creates the speech before the first question, so nothing can be lost', async () => {
    const memorialId = await signedInMemorial();
    const destination = await captureRedirect(() => startSpeechAction(form({ memorialId })));
    expect(destination).toMatch(/\/speeches\/[^/]+\/setup\/speaker$/);

    const speeches = listSpeeches(db(), memorialId);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]?.current.status).toBe('setup');
    // The organiser's own name is offered rather than an empty box.
    expect(speeches[0]?.current.speakerName).toBe('Anne Hartley');
  });

  it('asks one thing per screen, and offers only approved memories', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    insertOne(db(), memoryNotes, {
      memorialId,
      authorName: 'A neighbour',
      text: 'A memory nobody has approved.',
      approved: false,
    } as never);

    const destination = await captureRedirect(() => startSpeechAction(form({ memorialId })));
    const speechId = destination.split('/')[4] as string;

    const memoriesScreen = textOf(
      (await SpeechSetupPage({
        params: Promise.resolve({ memorialId, speechId, step: 'memories' }),
      })) as Node,
    );
    expect(memoriesScreen).toContain(NOTE_ONE);
    expect(memoriesScreen).toContain('Her daughter, Anne');
    expect(memoriesScreen).not.toContain('A memory nobody has approved.');
    // Nothing is ticked in advance — the speaker chooses the material.
    expect(notesOf(latestVersion(db(), speechId)).selectedMemoryIds).toEqual([]);
  });

  it('carries every answer through to the speech', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId, {
      targetMinutes: '7',
      tone: 'quiet-and-simple',
    });

    const current = latestVersion(db(), speechId);
    expect(current?.speakerName).toBe('Anne Hartley');
    expect(current?.relationship).toBe('her daughter');
    expect(current?.targetMinutes).toBe(7);
    expect(current?.tone).toBe('quiet-and-simple');
    expect(notesOf(current).selectedMemoryIds).toHaveLength(2);
    // Setup is written in place: there are no words to protect yet.
    expect(listVersions(db(), speechId)).toHaveLength(1);
  });

  it('opens the studio once the questions are behind them, not the questions again', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);

    // The wizard is closed, so this must render rather than redirect back into it.
    const page = textOf(
      (await SpeechPage({
        params: Promise.resolve({ memorialId, speechId }),
        searchParams: search(),
      })) as Node,
    );
    expect(page).toContain('Anne’s words');
    expect(latestVersion(db(), speechId)?.status).toBe('ready');
  });

  it('sends somebody who stopped half way back to the question they were on', async () => {
    const memorialId = await signedInMemorial();
    const destination = await captureRedirect(() => startSpeechAction(form({ memorialId })));
    const speechId = destination.split('/')[4] as string;
    await captureRedirect(() =>
      saveSetupStepAction(
        form({ memorialId, speechId, step: 'speaker', speakerName: 'Anne Hartley' }),
      ),
    );

    const back = await captureRedirect(() =>
      SpeechPage({
        params: Promise.resolve({ memorialId, speechId }),
        searchParams: search(),
      }),
    );
    expect(back).toBe(`/m/${memorialId}/speeches/${speechId}/setup/length`);
  });
});

describe('the first draft', () => {
  it('uses only the memories that were ticked, word for word', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    addStory(memorialId);
    const chosen = memoryIdsFor(memorialId);
    const speechId = await setUpSpeech(memorialId, { memoryIds: [chosen[0] as string] });

    expect(await draftSpeechAction({ memorialId, speechId })).toEqual({ ok: true });

    const current = latestVersion(db(), speechId);
    expect(current?.version).toBe(2);
    expect(current?.createdBy).toBe('ai');
    expect(current?.status).toBe('draft');
    // The memory she ticked is quoted exactly. The one she did not is absent.
    expect(current?.body).toContain(`"${NOTE_ONE}"`);
    expect(current?.body).not.toContain(NOTE_TWO);
    expect(notesOf(current).usedMemoryIds).toEqual([chosen[0]]);
    expect(notesOf(current).warnings).toEqual([]);
  });

  it('takes the quotation marks off anything nobody actually said', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const chosen = memoryIdsFor(memorialId);
    const speechId = await setUpSpeech(memorialId, {
      speakerName: 'Marion Hartley',
      relationship: 'her niece',
      memoryIds: [chosen[0] as string],
    });

    expect(await draftSpeechAction({ memorialId, speechId })).toEqual({ ok: true });

    const current = latestVersion(db(), speechId);
    const invented = 'Nobody has ever gone out of my front door on an empty stomach';
    expect(current?.body).toContain(invented);
    // The sentence survives; the claim that somebody said it does not.
    expect(current?.body).not.toContain(`"${invented}`);
    // The real memory, quoted properly, is untouched.
    expect(current?.body).toContain(`"${NOTE_ONE}"`);

    const notes = notesOf(current);
    expect(notes.warnings.join(' ')).toContain('not word for word');
    expect(notes.usedMemoryIds).not.toContain('a-memory-that-was-never-chosen');

    // And the screen tells her, plainly, what was changed.
    const page = textOf(
      (await SpeechPage({
        params: Promise.resolve({ memorialId, speechId }),
        searchParams: search(),
      })) as Node,
    );
    expect(page).toContain('Two small things we changed');
  });

  it('says one calm sentence when the writing assistant fails', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId, { speakerName: 'Wren Hollis' });

    const result = await draftSpeechAction({ memorialId, speechId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Nothing you wrote was lost');
      expect(result.message).not.toMatch(/schema|json|provider/i);
    }
    // Nothing was written, so the setup is exactly as it was.
    expect(listVersions(db(), speechId)).toHaveLength(1);
  });
});

describe('changing it', () => {
  it('appends a version per tool, and can always put the last one back', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });

    const firstDraft = latestVersion(db(), speechId);
    expect(await reviseSpeechAction({ memorialId, speechId, revision: 'shorter' })).toEqual({
      ok: true,
    });

    const shorter = latestVersion(db(), speechId);
    expect(shorter?.version).toBe(3);
    expect(shorter?.note).toBe('A little shorter');
    expect(shorter?.body.length).toBeLessThan((firstDraft?.body ?? '').length);

    expect(await reviseSpeechAction({ memorialId, speechId, revision: 'warmer' })).toEqual({
      ok: true,
    });
    expect(latestVersion(db(), speechId)?.note).toBe('Warmer');
    expect(listVersions(db(), speechId)).toHaveLength(4);

    // Going back is itself a version, so nothing is ever destroyed.
    await captureRedirect(() =>
      restoreVersionAction(
        form({ memorialId, speechId, versionId: (firstDraft as { id: string }).id }),
      ),
    );
    const restored = latestVersion(db(), speechId);
    expect(restored?.version).toBe(5);
    expect(restored?.body).toBe(firstDraft?.body);
    expect(restored?.note).toContain('Went back to version 2');
  });

  it('keeps a hand edit and never overwrites what a model wrote', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });
    const drafted = latestVersion(db(), speechId);

    await saveSpeechBodyAction({
      memorialId,
      speechId,
      body: `${drafted?.body}\n\nAnd one thing I have never told anyone.`,
    });
    expect(latestVersion(db(), speechId)?.version).toBe(3);

    // Further typing updates that same row rather than flooding the history.
    await saveSpeechBodyAction({ memorialId, speechId, body: 'Everything, rewritten.' });
    expect(listVersions(db(), speechId)).toHaveLength(3);
    expect(latestVersion(db(), speechId)?.body).toBe('Everything, rewritten.');
    // The AI version is still there, untouched.
    expect(listVersions(db(), speechId)[1]?.body).toBe(drafted?.body);
  });

  it('makes a graveside version alongside the speech, not instead of it', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });
    const full = latestVersion(db(), speechId);

    expect(await reviseSpeechAction({ memorialId, speechId, revision: 'graveside' })).toEqual({
      ok: true,
    });

    const graveside = latestVersion(db(), speechId, 'graveside');
    expect(graveside?.variant).toBe('graveside');
    expect(graveside?.body.length).toBeLessThan((full?.body ?? '').length);
    // The full speech is still what the studio opens on.
    expect(latestVersion(db(), speechId)?.body).toBe(full?.body);
    expect(listSpeeches(db(), memorialId)[0]?.graveside?.id).toBe(graveside?.id);

    // Shortening while the graveside version is on screen changes that one, and
    // leaves the full speech alone.
    expect(
      await reviseSpeechAction({
        memorialId,
        speechId,
        revision: 'shorter',
        variant: 'graveside',
      }),
    ).toEqual({ ok: true });
    expect(latestVersion(db(), speechId, 'graveside')?.note).toBe('A little shorter');
    expect(latestVersion(db(), speechId)?.body).toBe(full?.body);
  });

  it('removes a speech softly, and puts it back', async () => {
    const memorialId = await signedInMemorial();
    const speechId = await setUpSpeech(memorialId);

    const { message } = await removeSpeechAction(memorialId, speechId);
    expect(message).toContain('removed');
    expect(listSpeeches(db(), memorialId)).toHaveLength(0);

    await restoreSpeechAction(memorialId, speechId);
    expect(listSpeeches(db(), memorialId)).toHaveLength(1);
  });
});

describe('the screens', () => {
  it('lists the speeches, and says what it will and will not do', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });

    const page = textOf((await SpeechesPage({ params: params(memorialId) })) as Node);
    expect(page).toContain('Anne’s words');
    expect(page).toContain('her daughter');
    expect(page).toContain('The printed program');
  });

  it('prints the speech large, with pauses as a quiet line', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });

    const page = textOf(
      (await SpeechPrintPage({
        params: Promise.resolve({ memorialId, speechId }),
        searchParams: search(),
      })) as Node,
    );
    expect(page).toContain('Anne’s words');
    expect(page).toContain('Anne Hartley');
    expect(page).toContain(NOTE_ONE);
    // The marker itself never appears on paper; it becomes three dots.
    expect(page).not.toContain('[pause]');
    expect(page).toContain('· · ·');
    expect(page).toContain('— end —');
  });
});

/* -------------------------------------------------------------------------- */
/* the program                                                                 */
/* -------------------------------------------------------------------------- */

describe('the printed program', () => {
  it('prefills the order of service from the family’s tradition', async () => {
    // One at a time: signing in for a new memorial replaces the session cookie,
    // exactly as it would in a browser.
    const orderFor = async (tradition: string) => {
      const memorialId = await signedInMemorial(tradition);
      return textOf(
        (await ProgramStepPage({
          params: Promise.resolve({ memorialId, step: 'order' }),
        })) as Node,
      );
    };

    const catholic = await orderFor('catholic');
    expect(catholic).toContain('Liturgy of the Eucharist');
    expect(catholic).toContain('Final Commendation and Farewell');

    const secular = await orderFor('secular');
    expect(secular).toContain('Tributes');
    expect(secular).not.toContain('Liturgy of the Eucharist');

    expect(await orderFor('homegoing')).toContain('Reading of the obituary');
  });

  it('lets an organiser add, move and remove lines with buttons', async () => {
    const memorialId = await signedInMemorial();
    const memorial = getById(db(), memorials, memorialId);
    if (!memorial) throw new Error('memorial vanished');

    const before = currentProgram(db(), memorial).doc.orderOfService.length;
    await captureRedirect(() =>
      orderItemAction(
        form({ memorialId, op: 'add', item: 'A poem, read by Nell', note: 'Her granddaughter' }),
      ),
    );
    const added = currentProgram(db(), memorial).doc;
    expect(added.orderOfService).toHaveLength(before + 1);
    expect(added.orderOfService.at(-1)?.note).toBe('Her granddaughter');

    await captureRedirect(() =>
      orderItemAction(form({ memorialId, op: 'up', index: String(before) })),
    );
    expect(currentProgram(db(), memorial).doc.orderOfService[before - 1]?.item).toBe(
      'A poem, read by Nell',
    );

    await captureRedirect(() =>
      orderItemAction(
        form({ memorialId, op: 'rename', index: String(before - 1), item: 'A poem', note: 'Nell' }),
      ),
    );
    expect(currentProgram(db(), memorial).doc.orderOfService[before - 1]).toEqual({
      item: 'A poem',
      note: 'Nell',
    });

    await captureRedirect(() =>
      orderItemAction(form({ memorialId, op: 'remove', index: String(before - 1) })),
    );
    expect(currentProgram(db(), memorial).doc.orderOfService).toHaveLength(before);
  });

  it('drafts the life sketch from their story, and keeps every version', async () => {
    const memorialId = await signedInMemorial();
    addStory(memorialId);
    const memorial = getById(db(), memorials, memorialId);
    if (!memorial) throw new Error('memorial vanished');

    expect(await draftSketchAction({ memorialId })).toEqual({ ok: true });
    const drafted = currentProgram(db(), memorial);
    expect(drafted.doc.lifeSketch).toContain('Ruth was born in 1936');
    expect(drafted.version).toBeGreaterThan(0);

    // A hand edit on top of a drafted sketch appends rather than overwriting.
    const { saveSketchAction } = await import('./m/[memorialId]/program/actions');
    await saveSketchAction({ memorialId, text: 'Anne wrote this one herself.' });
    const edited = currentProgram(db(), memorial);
    expect(edited.doc.lifeSketch).toBe('Anne wrote this one herself.');
    expect(edited.version).toBe(drafted.version + 1);
  });

  it('offers only readings we may print, and takes the family’s own', async () => {
    const memorialId = await signedInMemorial();
    const memorial = getById(db(), memorials, memorialId);
    if (!memorial) throw new Error('memorial vanished');

    const page = textOf(
      (await ProgramStepPage({
        params: Promise.resolve({ memorialId, step: 'reading' }),
      })) as Node,
    );
    expect(page).toContain('Do Not Stand at My Grave and Weep');
    expect(page).toContain('public domain');

    await captureRedirect(() => saveReadingAction(form({ memorialId, choice: '0' })));
    expect(currentProgram(db(), memorial).doc.reading?.title).toContain('Do Not Stand at My Grave');

    await captureRedirect(() =>
      saveReadingAction(
        form({
          memorialId,
          choice: 'own',
          title: 'The blessing she used',
          text: 'May the road rise to meet you.',
          source: 'Traditional, in her handwriting',
        }),
      ),
    );
    expect(currentProgram(db(), memorial).doc.reading?.title).toBe('The blessing she used');

    await captureRedirect(() => saveReadingAction(form({ memorialId, choice: 'none' })));
    expect(currentProgram(db(), memorial).doc.reading).toBeUndefined();
  });

  it('prints as four labelled pages, and as text a funeral home can paste', async () => {
    const memorialId = await signedInMemorial();
    addStory(memorialId);
    await draftSketchAction({ memorialId });
    await captureRedirect(() => saveReadingAction(form({ memorialId, choice: '0' })));
    await captureRedirect(() =>
      saveThanksAction(
        form({
          memorialId,
          acknowledgments: 'The family thank you for every kindness.',
          backNote: 'Please join us afterwards at the Meeting House.',
        }),
      ),
    );

    const page = textOf(
      (await ProgramPrintPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(page).toContain('Page 1 — the front cover');
    expect(page).toContain('Page 4 — the back, and the thank you');
    expect(page).toContain('In Loving Memory');
    expect(page).toContain('Ruth Hartley');
    expect(page).toContain('Order of Service');
    expect(page).toContain('Ruth was born in 1936');
    expect(page).toContain('Do Not Stand at My Grave and Weep');
    expect(page).toContain('The family thank you for every kindness.');
    expect(page).toContain('half fold');

    const letter = textOf(
      (await ProgramPrintPage({
        params: params(memorialId),
        searchParams: search({ paper: 'letter' }),
      })) as Node,
    );
    expect(letter).toContain('US Letter');

    const response = await getProgramText(new Request('http://localhost/x'), {
      params: params(memorialId),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('ORDER OF SERVICE');
    expect(text).toContain('WITH THANKS');
    expect(text).toContain('Ruth Hartley');
  });

  it('will not hand the program to somebody who is not signed in', async () => {
    const memorialId = await signedInMemorial();
    cookieJar.clear();
    const response = await getProgramText(new Request('http://localhost/x'), {
      params: params(memorialId),
    });
    expect(response.status).toBe(403);
  });

  it('shows how far along it is, and where to carry on', async () => {
    const memorialId = await signedInMemorial();
    const page = textOf((await ProgramPage({ params: params(memorialId) })) as Node);
    expect(page).toContain('The front cover');
    expect(page).toContain('The order of service');
    expect(page).toContain('life sketch');

    await captureRedirect(() => continueProgramAction(form({ memorialId, step: 'order' }))).then(
      (destination) => expect(destination).toContain('/program/sketch'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* the dashboard                                                               */
/* -------------------------------------------------------------------------- */

describe('the dashboard', () => {
  it('offers speeches and the program from the first evening', async () => {
    const memorialId = await signedInMemorial();
    const page = textOf((await DashboardPage({ params: params(memorialId) })) as Node);
    expect(page).toContain('Speeches & program');
    expect(page).toContain('eulogy');
  });

  it('counts what has been written', async () => {
    const memorialId = await signedInMemorial();
    addMemories(memorialId);
    const speechId = await setUpSpeech(memorialId);
    await draftSpeechAction({ memorialId, speechId });
    await draftSketchAction({ memorialId });

    const page = textOf((await DashboardPage({ params: params(memorialId) })) as Node);
    expect(page).toContain('1 speech written');

    const memorial = getById(db(), memorials, memorialId);
    expect(memorial?.checklist['hasSpeech']).toBe(true);
  });
});
