/**
 * The review loop, headless.
 *
 * Two journeys meet here. Somebody with a viewing link watches the video,
 * spots that a photograph is the wrong person, and says so — with a tap for
 * "at this moment" and nothing else asked of them. The organiser then reads it
 * on their own screen, marks it done, and can undo that.
 *
 * Alongside it, the other half of sharing the work: an invite link that hands
 * somebody the organiser's own job. Everything about it is checked against the
 * same rule the rest of the product lives by — a link is worth exactly nothing
 * against another family's memorial, and turning it off means turning it off.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-review-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'review.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'review-test-secret';
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
const { createWatchLinkAction, revokeWatchLinkAction } =
  await import('./m/[memorialId]/deliver/actions');
const { leaveNoteAction } = await import('./w/[token]/actions');
const { setNoteStatusAction } = await import('./m/[memorialId]/review/actions');
const { createInviteAction, revokeInviteAction } = await import('./m/[memorialId]/share/actions');
const { joinAsCoOrganizerAction } = await import('./join/[token]/actions');
const WatchPage = (await import('./w/[token]/page')).default;
const ReviewPage = (await import('./m/[memorialId]/review/page')).default;
const SharePage = (await import('./m/[memorialId]/share/page')).default;
const JoinPage = (await import('./join/[token]/page')).default;
const DashboardPage = (await import('./m/[memorialId]/page')).default;
const DeliverPage = (await import('./m/[memorialId]/deliver/page')).default;

const {
  DevConsoleTransport,
  buildContext,
  generateEdl,
  getOrCreateProject,
  listCoOrganizerInvites,
  listReviewNotes,
  listWatchLinks,
  requestLoginLink,
  saveEdl,
  setMailTransport,
} = await import('@col/core');
const { insertOne, mediaAssets, memoryNotes, renderJobs, updateById } = await import('@col/db');
const { getBlobStore } = await import('@col/storage');
const { resetMockState } = await import('@col/ai');

const VIDEO_BYTES = Buffer.from('x'.repeat(2048));

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

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function signedInMemorial(name = 'Ruth Anne Kelleher'): Promise<string> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: name,
        organizerName: 'Anne Doyle',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  return destination.split('/')[2] as string;
}

/** Sign back in as the organizer of a memorial made earlier in this file. */
async function signInAs(memorialId: string): Promise<void> {
  const { listWhere, participants } = await import('@col/db');
  const organizer = listWhere(db(), participants).find(
    (p) => p.memorialId === memorialId && p.role === 'organizer',
  );
  if (!organizer) throw new Error('no organizer');
  const { writeSession } = await import('@/server/session');
  await writeSession({
    participantId: organizer.id,
    memorialId,
    role: 'organizer',
    issuedAt: Date.now(),
  });
}

/** A memorial with a slideshow and one finished, verified render. */
async function memorialWithVideo(name?: string): Promise<{ memorialId: string; renderId: string }> {
  const memorialId = await signedInMemorial(name);

  for (let i = 0; i < 12; i += 1) {
    const year = 1950 + i * 6;
    insertOne(db(), mediaAssets, {
      memorialId,
      originalFilename: `photo-${i}.jpg`,
      mime: 'image/jpeg',
      blobKey: `memorial/${memorialId}/original/photo-${i}.jpg`,
      curationState: 'approved',
      ingestState: 'ready',
      capturedAt: Date.UTC(year, 3, 1),
      eraGuess: `${Math.floor(year / 10) * 10}s`,
      width: 4000,
      height: 3000,
      analysis: {
        description: `A photograph from ${year}`,
        settingTags: ['home'],
        emotionalTone: 'warm',
        slideSuitability: Number((0.3 + (i % 6) * 0.1).toFixed(2)),
      },
    } as never);
  }
  insertOne(db(), memoryNotes, {
    memorialId,
    authorName: 'Her daughter, Anne',
    text: 'She always said the garden would outlive her.',
    approved: true,
  } as never);

  const project = getOrCreateProject(db(), memorialId);
  const result = await generateEdl(buildContext(db(), memorialId, project.id));
  saveEdl(db(), project.id, result.edl, { status: 'ready' });

  const job = insertOne(db(), renderJobs, {
    memorialId,
    projectId: project.id,
    cut: 'service',
    preset: 'final1080',
    status: 'queued',
  } as never) as { id: string };

  const key = `memorial/${memorialId}/render/${job.id}.mp4`;
  await getBlobStore().put(key, VIDEO_BYTES, 'video/mp4');
  updateById(db(), renderJobs, job.id, {
    status: 'done',
    progress: 1,
    durationSec: 302,
    outputBlobKey: key,
  });
  return { memorialId, renderId: job.id };
}

async function shareWatchLink(memorialId: string): Promise<{ token: string; tokenId: string }> {
  await captureRedirect(() => createWatchLinkAction(form({ memorialId })));
  const link = listWatchLinks(db(), memorialId).find((l) => l.active);
  if (!link?.token) throw new Error('no viewing link was made');
  return { token: link.token, tokenId: link.row.id };
}

async function shareInvite(memorialId: string): Promise<{ token: string; tokenId: string }> {
  await captureRedirect(() => createInviteAction(form({ memorialId })));
  const invite = listCoOrganizerInvites(db(), memorialId).find((i) => i.active);
  if (!invite?.token) throw new Error('no invite link was made');
  return { token: invite.token, tokenId: invite.row.id };
}

/* --- rendering server components without a browser ------------------------ */

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
  'poster',
]);

const CLIENT_COMPONENTS = new Set([
  'CopyBox',
  'RenderWatch',
  'RemoveMemorial',
  'Stage',
  'NoteForm',
  'NoteActions',
]);

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
        /* needs a browser */
      }
    }
  }

  return Object.entries(props)
    .filter(([key]) => !NOT_TEXT.has(key))
    .map(([, value]) => textOf(value as Node))
    .join(' ');
}

function urlsOf(node: Node, found: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) urlsOf(child, found);
    return found;
  }
  if (!isElement(node)) return found;
  const props = node.props as Record<string, unknown>;
  for (const key of ['href', 'src', 'value']) {
    if (typeof props[key] === 'string') found.push(props[key] as string);
  }

  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name =
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) urlsOf(rendered as Node, found);
      } catch {
        /* needs a browser */
      }
    }
  }
  for (const value of Object.values(props)) urlsOf(value as Node, found);
  return found;
}

const params = (memorialId: string) => Promise.resolve({ memorialId });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);
const tokenParams = (token: string) => Promise.resolve({ token });

/* -------------------------------------------------------------------------- */
/* leaving a note                                                              */
/* -------------------------------------------------------------------------- */

describe('a note from somebody watching', () => {
  it('is invited under the video, and says who will read it', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear(); // a stranger's browser: no session at all
    const page = (await WatchPage({
      params: tokenParams(token),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    expect(text).toContain('Spotted something, or have a thought? Tell Anne.');
    expect(text).toContain('Only Anne will see this.');
    // Nothing about accounts, and nothing anybody else wrote.
    expect(text).not.toMatch(/sign up|create an account/i);
  });

  it('is written down against the memorial the link belongs to', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const destination = await captureRedirect(() =>
      leaveNoteAction(
        form({
          token,
          name: 'Michael',
          note: 'That is Margaret at the front, not Ruth.',
          timecodeMs: '9000',
        }),
      ),
    );
    expect(destination).toContain('sent=1');

    const notes = listReviewNotes(db(), memorialId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.authorName).toBe('Michael');
    expect(notes[0]?.body).toBe('That is Margaret at the front, not Ruth.');
    expect(notes[0]?.timecodeMs).toBe(9_000);
    // The draft they were watching is remembered, and so is the slide.
    expect(notes[0]?.renderJobId).toBe(renderId);
    expect(notes[0]?.slideId).toBeTruthy();
    expect(notes[0]?.createdVia).toBe('watch');
  });

  it('keeps the words and drops anything that looks like markup', async () => {
    const { memorialId } = await memorialWithVideo('Bridget Nolan');
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    await captureRedirect(() =>
      leaveNoteAction(
        form({ token, name: '<b>Michael</b>', note: 'Lovely<script>alert(1)</script>' }),
      ),
    );

    const note = listReviewNotes(db(), memorialId)[0];
    expect(note?.body).toBe('Lovely');
    expect(note?.authorName).toBe('Michael');
  });

  it('writes nothing once the link has been turned off, and says so gently', async () => {
    const { memorialId } = await memorialWithVideo('Margaret Doyle');
    const { token, tokenId } = await shareWatchLink(memorialId);
    await captureRedirect(() => revokeWatchLinkAction(form({ memorialId, tokenId })));

    cookieJar.clear();
    await captureRedirect(() => leaveNoteAction(form({ token, name: 'Late', note: 'Hello?' })));
    expect(listReviewNotes(db(), memorialId)).toHaveLength(0);

    const text = textOf(
      (await WatchPage({ params: tokenParams(token), searchParams: search() })) as Node,
    );
    expect(text).toContain('This link is no longer active');
    expect(text).not.toMatch(/error|invalid|denied|forbidden/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the organiser's screen                                                      */
/* -------------------------------------------------------------------------- */

describe('the organiser reading them', () => {
  it('shows each note with who wrote it and where they were', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    await captureRedirect(() =>
      leaveNoteAction(
        form({ token, name: 'Michael', note: 'The spelling of his name.', timecodeMs: '9000' }),
      ),
    );

    await signInAs(memorialId);
    const page = (await ReviewPage({ params: params(memorialId) })) as Node;
    const text = textOf(page);

    expect(text).toContain('Michael');
    expect(text).toContain('The spelling of his name.');
    expect(text).toContain('at 0:09');
    expect(text).toContain('Only you see these');
    // And a way straight to the slide it is about.
    expect(urlsOf(page).some((url) => url.includes(`/m/${memorialId}/preview#slide-`))).toBe(true);
  });

  it('opens with a kind empty state rather than a blank page', async () => {
    const { memorialId } = await memorialWithVideo('Peggy Fallon');
    await signInAs(memorialId);
    const text = textOf((await ReviewPage({ params: params(memorialId) })) as Node);
    expect(text).toContain('No notes yet');
    expect(text).toContain('they can leave a thought here');
  });

  it('marks one done, and puts it back exactly', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);
    cookieJar.clear();
    await captureRedirect(() => leaveNoteAction(form({ token, note: 'The last card.' })));
    const noteId = listReviewNotes(db(), memorialId)[0]?.id as string;

    await signInAs(memorialId);
    const done = await setNoteStatusAction(memorialId, noteId, 'done');
    expect(done.previous).toBe('open');
    expect(listReviewNotes(db(), memorialId)[0]?.status).toBe('done');

    await setNoteStatusAction(memorialId, noteId, done.previous);
    expect(listReviewNotes(db(), memorialId)[0]?.status).toBe('open');
    // Nothing was thrown away on the way round.
    expect(listReviewNotes(db(), memorialId)[0]?.body).toBe('The last card.');
  });

  it('is organizer-only, and never another family’s', async () => {
    const a = await memorialWithVideo('Ruth Anne Kelleher');
    const b = await memorialWithVideo('Patrick Byrne');
    const { token } = await (async () => {
      await signInAs(a.memorialId);
      return shareWatchLink(a.memorialId);
    })();

    cookieJar.clear();
    await captureRedirect(() => leaveNoteAction(form({ token, note: 'A note for A.' })));
    const noteId = listReviewNotes(db(), a.memorialId)[0]?.id as string;

    cookieJar.clear();
    await expect(ReviewPage({ params: params(a.memorialId) })).rejects.toBeTruthy();

    // Signed in for B, A's note cannot be touched.
    await signInAs(b.memorialId);
    await expect(setNoteStatusAction(a.memorialId, noteId, 'done')).rejects.toBeTruthy();
    expect(listReviewNotes(db(), a.memorialId)[0]?.status).toBe('open');
    expect(listReviewNotes(db(), b.memorialId)).toHaveLength(0);
  });

  it('is offered from the deliver screen and the dashboard once there are notes', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);
    cookieJar.clear();
    await captureRedirect(() => leaveNoteAction(form({ token, note: 'One thing.' })));

    await signInAs(memorialId);
    const deliver = (await DeliverPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    expect(textOf(deliver)).toMatch(/1\s+note\s+from family/);
    expect(urlsOf(deliver)).toContain(`/m/${memorialId}/review`);

    const dashboard = (await DashboardPage({ params: params(memorialId) })) as Node;
    expect(textOf(dashboard)).toContain('Notes from family (1)');
  });
});

/* -------------------------------------------------------------------------- */
/* sharing the work                                                            */
/* -------------------------------------------------------------------------- */

describe('inviting a co-organizer', () => {
  it('is made from the dashboard’s share screen, and shown with a copy box', async () => {
    const memorialId = await signedInMemorial('Ruth Anne Kelleher');
    const { token } = await shareInvite(memorialId);

    const page = (await SharePage({
      params: params(memorialId),
      searchParams: search({ made: '1' }),
    })) as Node;
    expect(textOf(page)).toContain('everything you can');
    expect(textOf(page)).toContain('share it carefully');
    expect(urlsOf(page).some((url) => url.includes(`/join/${token}`))).toBe(true);
  });

  it('needs an organizer session — a stranger cannot make one', async () => {
    const memorialId = await signedInMemorial('Peggy Fallon');
    cookieJar.clear();
    await expect(createInviteAction(form({ memorialId }))).rejects.toBeTruthy();
    expect(listCoOrganizerInvites(db(), memorialId)).toHaveLength(0);
  });

  it('lets whoever opens it into that memorial, and no other', async () => {
    const memorialId = await signedInMemorial('Ruth Anne Kelleher');
    const otherMemorialId = await signedInMemorial('Patrick Byrne');
    await signInAs(memorialId);
    const { token } = await shareInvite(memorialId);

    cookieJar.clear();
    const landed = await captureRedirect(() =>
      joinAsCoOrganizerAction(form({ token, name: 'Michael', email: 'michael@example.test' })),
    );
    expect(landed).toBe(`/m/${memorialId}`);

    // The session they were given works on this memorial…
    const dashboard = (await DashboardPage({ params: params(memorialId) })) as Node;
    expect(textOf(dashboard)).toContain('Ruth Anne Kelleher');
    // …and is worth nothing against another family's.
    await expect(DashboardPage({ params: params(otherMemorialId) })).rejects.toBeTruthy();
  });

  it('keeps the magic-link way back in working for them too', async () => {
    const memorialId = await signedInMemorial('Bridget Nolan');
    const { token } = await shareInvite(memorialId);

    cookieJar.clear();
    await captureRedirect(() =>
      joinAsCoOrganizerAction(form({ token, name: 'Michael', email: 'michael+co@example.test' })),
    );

    // Two organizers on one memorial now; asking for a link by email must
    // still find the right one rather than assuming there is only ever one.
    const result = requestLoginLink(db(), 'michael+co@example.test');
    expect(result.accepted).toBe(true);
    expect(result.memorial?.id).toBe(memorialId);
    expect(result.issued?.url).toContain('/auth/');
  });

  it('asks again, kindly, when the email is not usable', async () => {
    const memorialId = await signedInMemorial('Margaret Doyle');
    const { token } = await shareInvite(memorialId);

    cookieJar.clear();
    const back = await captureRedirect(() =>
      joinAsCoOrganizerAction(form({ token, name: 'Michael', email: 'not-an-address' })),
    );
    expect(back).toBe(`/join/${token}?check=email`);

    const text = textOf(
      (await JoinPage({
        params: tokenParams(token),
        searchParams: search({ check: 'email' }),
      })) as Node,
    );
    expect(text).toContain('Please check the email address.');
  });

  it('shows the same gentle closed page once the invite is turned off', async () => {
    const memorialId = await signedInMemorial('Peggy Fallon');
    const { token, tokenId } = await shareInvite(memorialId);
    await captureRedirect(() => revokeInviteAction(form({ memorialId, tokenId })));

    cookieJar.clear();
    const text = textOf(
      (await JoinPage({ params: tokenParams(token), searchParams: search() })) as Node,
    );
    expect(text).toContain('This link is no longer active');
    expect(text).not.toMatch(/error|invalid|denied|forbidden/i);

    // And it cannot be used behind the page's back.
    await captureRedirect(() =>
      joinAsCoOrganizerAction(form({ token, name: 'Late', email: 'late@example.test' })),
    );
    const { listWhere, participants } = await import('@col/db');
    expect(
      listWhere(db(), participants).filter((p) => p.email === 'late@example.test'),
    ).toHaveLength(0);
  });

  it('opens one screen and nothing else: it is not a contributor link', async () => {
    const memorialId = await signedInMemorial('Ruth Anne Kelleher');
    const { token } = await shareInvite(memorialId);
    const { resolveCollectionToken } = await import('@col/core');

    cookieJar.clear();
    const asContributor = resolveCollectionToken(db(), token);
    expect(asContributor.ok).toBe(false);
  });
});
