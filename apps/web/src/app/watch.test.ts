/**
 * The hosted viewing page and the venue screen, headless.
 *
 * Everything in this file is about one question: who can see a family's video.
 * The organiser can, through their session. Somebody holding a private viewing
 * link can, for that one memorial, until it is turned off. Nobody else can, and
 * a link for one family must be worth exactly nothing against another's.
 *
 * The other half is the mechanics that make a video usable in a browser: a
 * range request has to come back 206 with a correct Content-Range, or the scrub
 * bar does not work and the page looks broken to somebody who is grieving.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-watch-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'watch.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'watch-test-secret';
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
const { createWatchLinkAction, revokeWatchLinkAction, setWatchDownloadAction } =
  await import('./m/[memorialId]/deliver/actions');
const WatchPage = (await import('./w/[token]/page')).default;
const DeliverPage = (await import('./m/[memorialId]/deliver/page')).default;
const PresentPage = (await import('./m/[memorialId]/present/page')).default;
const { GET: streamRender } = await import('./api/renders/[renderJobId]/route');

const {
  DevConsoleTransport,
  buildContext,
  generateEdl,
  getOrCreateProject,
  listWatchLinks,
  saveEdl,
  setMailTransport,
} = await import('@col/core');
const { insertOne, mediaAssets, memoryNotes, renderJobs, updateById } = await import('@col/db');
const { getBlobStore } = await import('@col/storage');
const { resetMockState } = await import('@col/ai');

/** Enough bytes that a range request has something to slice. */
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

/** Enough approved photographs and one memory that an EDL can be generated. */
async function withSlideshow(memorialId: string): Promise<string> {
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
  return project.id;
}

/** A memorial with a finished, verified render sitting in the blob store. */
async function memorialWithVideo(
  name?: string,
  preset: 'final1080' | 'draft360' = 'final1080',
): Promise<{ memorialId: string; renderId: string }> {
  const memorialId = await signedInMemorial(name);
  const projectId = await withSlideshow(memorialId);
  const job = insertOne(db(), renderJobs, {
    memorialId,
    projectId,
    cut: 'service',
    preset,
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

/** Make a viewing link the way the deliver screen does, and read it back. */
async function shareWatchLink(memorialId: string): Promise<{ token: string; tokenId: string }> {
  await captureRedirect(() => createWatchLinkAction(form({ memorialId })));
  const link = listWatchLinks(db(), memorialId).find((l) => l.active);
  if (!link?.token) throw new Error('no viewing link was made');
  return { token: link.token, tokenId: link.row.id };
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

const CLIENT_COMPONENTS = new Set(['CopyBox', 'RenderWatch', 'RemoveMemorial', 'Stage']);

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

/** Every `src`/`href` on a page, for checking what it points at. */
function urlsOf(node: Node, found: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) urlsOf(child, found);
    return found;
  }
  if (!isElement(node)) return found;
  const props = node.props as Record<string, unknown>;
  for (const key of ['href', 'src', 'poster', 'value', 'videoSrc', 'posterSrc']) {
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
const renderParams = (renderJobId: string) => Promise.resolve({ renderJobId });

function get(url: string, headers?: Record<string, string>): Request {
  return new Request(url, headers ? { headers } : undefined);
}

/* -------------------------------------------------------------------------- */
/* sharing a link                                                              */
/* -------------------------------------------------------------------------- */

describe('sharing a private viewing link', () => {
  it('is offered on the deliver screen once there is a video', async () => {
    const { memorialId } = await memorialWithVideo();
    const page = (await DeliverPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    expect(text).toContain('For people who cannot be there');
    expect(text).toContain('Share a private viewing link');
    expect(text).toContain('turn it off at any time');
    // And a way into the venue screen.
    expect(urlsOf(page)).toContain(`/m/${memorialId}/present`);
  });

  it('shows the link back, and lets saving a copy be turned on and off', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token, tokenId } = await shareWatchLink(memorialId);

    const shown = urlsOf(
      (await DeliverPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(shown.some((url) => url.includes(`/w/${token}`))).toBe(true);

    await captureRedirect(() =>
      setWatchDownloadAction(form({ memorialId, tokenId, allow: 'yes' })),
    );
    expect(listWatchLinks(db(), memorialId)[0]?.allowDownload).toBe(true);

    await captureRedirect(() => setWatchDownloadAction(form({ memorialId, tokenId, allow: 'no' })));
    expect(listWatchLinks(db(), memorialId)[0]?.allowDownload).toBe(false);
  });

  it('needs an organizer session — a stranger cannot make one', async () => {
    const { memorialId } = await memorialWithVideo();
    cookieJar.clear();
    await expect(createWatchLinkAction(form({ memorialId }))).rejects.toBeTruthy();
    expect(listWatchLinks(db(), memorialId)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* the watch page                                                              */
/* -------------------------------------------------------------------------- */

describe('the hosted watch page', () => {
  it('opens gently, names the person, and never autoplays', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear(); // a stranger's browser: no session at all
    const page = (await WatchPage({ params: tokenParams(token) })) as Node;
    const text = textOf(page);
    const urls = urlsOf(page);

    expect(text).toContain('In loving memory of Ruth Anne Kelleher');
    expect(text).toContain('The link keeps working');
    expect(urls).toContain(`/api/renders/${renderId}?watch=${token}`);
    expect(urls).toContain(`/api/renders/${renderId}/poster?watch=${token}`);
    // Nothing about signing up, and nothing about downloading unless allowed.
    expect(text).not.toMatch(/sign up|create an account/i);
    expect(text).not.toContain('Save a copy');
  });

  it('offers the file only when the family said it could', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token, tokenId } = await shareWatchLink(memorialId);
    await captureRedirect(() =>
      setWatchDownloadAction(form({ memorialId, tokenId, allow: 'yes' })),
    );

    cookieJar.clear();
    const page = (await WatchPage({ params: tokenParams(token) })) as Node;
    expect(textOf(page)).toContain('Save a copy');
    expect(urlsOf(page)).toContain(`/api/renders/${renderId}?watch=${token}&download=1`);
  });

  it('says the video is not ready rather than showing an empty player', async () => {
    const memorialId = await signedInMemorial('Margaret Doyle');
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const text = textOf((await WatchPage({ params: tokenParams(token) })) as Node);
    expect(text).toContain('not ready yet');
    expect(text).toContain('keep this link');
  });

  it('shows the same gentle closed page a contributor gets, once turned off', async () => {
    const { memorialId } = await memorialWithVideo();
    const { token, tokenId } = await shareWatchLink(memorialId);
    await captureRedirect(() => revokeWatchLinkAction(form({ memorialId, tokenId })));

    cookieJar.clear();
    const text = textOf((await WatchPage({ params: tokenParams(token) })) as Node);
    expect(text).toContain('This link is no longer active');
    expect(text).toContain('Anything you already shared is safe with them');
    // No blame, and no hint that something was deleted.
    expect(text).not.toMatch(/error|invalid|denied|forbidden/i);
  });

  it('shows the same page for a link that never existed', async () => {
    const text = textOf(
      (await WatchPage({ params: tokenParams('nonsense-token-000000000000') })) as Node,
    );
    expect(text).toContain('could not find that link');
  });

  it('is honest when all there is to watch is a quick draft', async () => {
    const { memorialId } = await memorialWithVideo('Bridget Nolan', 'draft360');
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const text = textOf((await WatchPage({ params: tokenParams(token) })) as Node);
    expect(text).toContain('early version');
  });
});

/* -------------------------------------------------------------------------- */
/* the stream behind it                                                        */
/* -------------------------------------------------------------------------- */

describe('streaming the video to a viewing link', () => {
  it('plays inline, and is never cached anywhere shared', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const response = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}`),
      { params: renderParams(renderId) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
  });

  it('answers a range request so the scrub bar works', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const response = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}`, { range: 'bytes=100-199' }),
      { params: renderParams(renderId) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 100-199/${VIDEO_BYTES.byteLength}`);
    expect(response.headers.get('content-length')).toBe('100');
    expect(await response.arrayBuffer()).toHaveProperty('byteLength', 100);
  });

  it('answers an open-ended range the way a video element asks for one', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const response = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}`, { range: 'bytes=0-' }),
      { params: renderParams(renderId) },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${VIDEO_BYTES.byteLength - 1}/${VIDEO_BYTES.byteLength}`,
    );
  });

  it('will not hand over the file unless the family allowed it', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token, tokenId } = await shareWatchLink(memorialId);

    cookieJar.clear();
    const refused = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}&download=1`),
      { params: renderParams(renderId) },
    );
    expect(refused.status).toBe(403);

    await signedInMemorialFor(memorialId);
    await captureRedirect(() =>
      setWatchDownloadAction(form({ memorialId, tokenId, allow: 'yes' })),
    );

    cookieJar.clear();
    const allowed = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}&download=1`),
      { params: renderParams(renderId) },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-disposition')).toContain('attachment');
    expect(allowed.headers.get('content-disposition')).toContain(
      'Ruth-Anne-Kelleher-Celebration-of-Life-Service.mp4',
    );
  });

  /** Sign back in as the organizer of a memorial made earlier in this test. */
  async function signedInMemorialFor(memorialId: string): Promise<void> {
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

  it('is worth nothing against another family’s video', async () => {
    const a = await memorialWithVideo('Ruth Anne Kelleher');
    const b = await memorialWithVideo('Patrick Byrne');

    // A viewing link made for memorial A…
    await signedInMemorialFor(a.memorialId);
    const { token } = await shareWatchLink(a.memorialId);

    cookieJar.clear();
    // …against memorial B's render.
    const response = await streamRender(
      get(`http://localhost/api/renders/${b.renderId}?watch=${token}`),
      { params: renderParams(b.renderId) },
    );
    expect(response.status).toBe(403);

    // And the page it would open shows A's memorial, never B's.
    const page = (await WatchPage({ params: tokenParams(token) })) as Node;
    expect(textOf(page)).toContain('Ruth Anne Kelleher');
    expect(textOf(page)).not.toContain('Patrick Byrne');
  });

  it('stops working the moment the link is turned off', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const { token, tokenId } = await shareWatchLink(memorialId);

    const before = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}`),
      { params: renderParams(renderId) },
    );
    expect(before.status).toBe(200);

    await captureRedirect(() => revokeWatchLinkAction(form({ memorialId, tokenId })));

    cookieJar.clear();
    const after = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=${token}`),
      { params: renderParams(renderId) },
    );
    expect(after.status).toBe(403);
  });

  it('refuses a made-up token, and a signed-out visitor with none', async () => {
    const { renderId } = await memorialWithVideo();

    cookieJar.clear();
    const invented = await streamRender(
      get(`http://localhost/api/renders/${renderId}?watch=not-a-token-at-all-0000`),
      { params: renderParams(renderId) },
    );
    expect(invented.status).toBe(403);

    const none = await streamRender(get(`http://localhost/api/renders/${renderId}`), {
      params: renderParams(renderId),
    });
    expect(none.status).toBe(403);
  });

  it('still downloads for the organizer, with the family’s own name on the file', async () => {
    const { renderId } = await memorialWithVideo();
    const response = await streamRender(get(`http://localhost/api/renders/${renderId}`), {
      params: renderParams(renderId),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain(
      'Ruth-Anne-Kelleher-Celebration-of-Life-Service.mp4',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* the venue screen                                                            */
/* -------------------------------------------------------------------------- */

describe('the venue playback screen', () => {
  it('plays the rendered file, from a same-origin authorised URL', async () => {
    const { memorialId, renderId } = await memorialWithVideo();
    const page = (await PresentPage({ params: params(memorialId) })) as Node;
    const urls = urlsOf(page);

    expect(urls).toContain(`/api/renders/${renderId}?inline=1`);
    expect(urls).toContain(`/api/renders/${renderId}/poster`);
    // Never a public URL, and never the preview composition.
    expect(urls.every((url) => url.startsWith('/'))).toBe(true);
  });

  it('explains itself rather than showing a black screen with no video', async () => {
    const memorialId = await signedInMemorial('Margaret Doyle');
    const text = textOf((await PresentPage({ params: params(memorialId) })) as Node);
    expect(text).toContain('no video to play yet');
  });

  it('is organizer-only', async () => {
    const { memorialId } = await memorialWithVideo();
    cookieJar.clear();
    await expect(PresentPage({ params: params(memorialId) })).rejects.toBeTruthy();
  });
});
