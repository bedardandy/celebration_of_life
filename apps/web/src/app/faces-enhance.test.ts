/**
 * Faces and improved copies, on the screen a family actually uses.
 *
 * The curation grid is where both features live, and the thing worth testing
 * about them is mostly what is *not* there: no face grouping on a machine with
 * no engine, no "improved" copy in front of anybody until they have looked at a
 * before and after and said so.
 *
 * Detection runs through the deterministic mock engine — the same one the
 * worker uses — so the groups are the same on every machine and no model is
 * downloaded by anything, ever.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-faces-web-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'faces.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'faces-test-secret';
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
const CuratePage = (await import('./m/[memorialId]/curate/page')).default;
const {
  dismissClusterAction,
  improvePhotoAction,
  keepOriginalAction,
  nameClusterAction,
  startFaceGroupingAction,
  useImprovedAction,
} = await import('./m/[memorialId]/curate/actions');
const {
  DevConsoleTransport,
  SESSION_COOKIE,
  ENHANCED_BADGE,
  listFaceClusters,
  namedFaces,
  recordFaceDetections,
  regroupFaces,
  setMailTransport,
} = await import('@col/core');
const { assetVariants, eq, insertOne, jobs, listWhere, mediaAssets, memorials, newId, updateById } =
  await import('@col/db');
const { MockFaceEngine } = await import('@col/media');

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
  process.env['FACE_ENGINE'] = 'mock';
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function createMemorial(): Promise<{ memorialId: string; session: string }> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: 'Ruth Kelleher',
        organizerName: 'Anne Kelleher',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  const memorialId = destination.split('/')[2] as string;
  updateById(db(), memorials, memorialId, { birthYear: 1938, deathYear: 2026 });
  return { memorialId, session: cookieJar.get(SESSION_COOKIE)?.value as string };
}

const signIn = (session: string) => cookieJar.set(SESSION_COOKIE, session);

/** A photograph that has already been through ingest. */
function photo(memorialId: string, filename: string, era: string): string {
  const assetId = newId();
  insertOne(db(), mediaAssets, {
    id: assetId,
    memorialId,
    originalFilename: filename,
    mime: 'image/jpeg',
    byteSize: 1024,
    blobKey: `memorial/${memorialId}/original/${assetId}.jpg`,
    ingestState: 'ready',
    curationState: 'approved',
    eraGuess: era,
  });
  for (const kind of ['thumb320', 'web1600', 'render2400'] as const) {
    insertOne(db(), assetVariants, {
      assetId,
      kind,
      blobKey: `memorial/${memorialId}/variant/${kind}/${assetId}.jpg`,
      mime: 'image/jpeg',
      byteSize: 1024,
    });
  }
  return assetId;
}

/**
 * What the worker's detect-faces job does, without the worker: the same mock
 * engine, the same two core calls.
 */
async function findFaces(memorialId: string): Promise<void> {
  const engine = new MockFaceEngine();
  for (const asset of listWhere(db(), mediaAssets, eq(mediaAssets.memorialId, memorialId))) {
    const faces = await engine.detect(Buffer.from(asset.id), {
      filename: asset.originalFilename,
      assetId: asset.id,
    });
    recordFaceDetections(db(), { memorialId, assetId: asset.id, engine: engine.id, faces });
  }
  regroupFaces(db(), memorialId);

  // …and the job it was doing is finished, so the screen stops saying "we are
  // looking through the photos".
  for (const job of listWhere(db(), jobs, eq(jobs.memorialId, memorialId))) {
    if (job.type === 'detect-faces') updateById(db(), jobs, job.id, { status: 'done' });
  }
}

/* --- rendering a server component without a browser ----------------------- */

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
]);

function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';

  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    try {
      const rendered = (type as (p: unknown) => unknown)(props);
      if (!(rendered instanceof Promise)) return textOf(rendered as Node);
    } catch {
      /* needs a browser */
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
  for (const key of ['href', 'src']) {
    if (typeof props[key] === 'string') found.push(props[key] as string);
  }
  const type = node.type as unknown;
  if (typeof type === 'function') {
    try {
      const rendered = (type as (p: unknown) => unknown)(props);
      if (!(rendered instanceof Promise)) urlsOf(rendered as Node, found);
    } catch {
      /* needs a browser */
    }
  }
  for (const value of Object.values(props)) urlsOf(value as Node, found);
  return found;
}

const params = (memorialId: string) => Promise.resolve({ memorialId });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

const curate = (memorialId: string, query: Record<string, string> = {}) =>
  CuratePage({ params: params(memorialId), searchParams: search(query) }) as Promise<Node>;

/* -------------------------------------------------------------------------- */

describe('face grouping on the curation screen', () => {
  it('is completely absent on a machine with no engine installed', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    photo(memorialId, 'ruth-1962.jpg', '1960s');
    process.env['FACE_ENGINE'] = 'off';

    const text = textOf(await curate(memorialId));
    expect(text).not.toMatch(/same faces/i);
    expect(text).not.toMatch(/same person/i);
    // No dead button, and the rest of the screen is exactly as it was.
    expect(text).toMatch(/Tap a photo to keep it/);
  });

  it('offers it with the sentence that says where the work happens', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    photo(memorialId, 'ruth-1962.jpg', '1960s');

    const text = textOf(await curate(memorialId));
    expect(text).toMatch(/Find the same faces across your photos/);
    expect(text).toMatch(/entirely on this computer and is deleted with the memorial/);
  });

  it('starts only when the organiser presses the button', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    photo(memorialId, 'ruth-1962.jpg', '1960s');

    expect(listWhere(db(), jobs, eq(jobs.memorialId, memorialId))).toHaveLength(0);

    const back = await captureRedirect(() => startFaceGroupingAction(form({ memorialId })));
    expect(back).toContain('faces=started');

    const queued = listWhere(db(), jobs, eq(jobs.memorialId, memorialId));
    expect(queued.map((job) => job.type)).toEqual(['detect-faces']);
  });

  it('carries a group all the way to a filter chip and a coverage nudge', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    photo(memorialId, 'ruth-1962.jpg', '1960s');
    photo(memorialId, 'ruth-1988.jpg', '1980s');
    photo(memorialId, 'harold-1975.jpg', '1970s');
    await captureRedirect(() => startFaceGroupingAction(form({ memorialId })));
    await findFaces(memorialId);

    // The suggestion, hedged: "look like", not "are".
    const suggested = textOf(await curate(memorialId));
    expect(suggested).toMatch(/These look like the same person/);
    expect(suggested).toMatch(/Not the same person/);

    const cluster = listFaceClusters(db(), memorialId).find((c) => c.photoCount === 2);
    await captureRedirect(() =>
      nameClusterAction(
        form({ memorialId, clusterId: cluster?.clusterId as string, name: 'Ruth' }),
      ),
    );

    expect(namedFaces(db(), memorialId)[0]).toMatchObject({ name: 'Ruth', photoCount: 2 });

    // The chip.
    const named = await curate(memorialId);
    expect(textOf(named)).toMatch(/Ruth · 2 photos/);
    const personId = namedFaces(db(), memorialId)[0]?.personId as string;
    expect(urlsOf(named)).toContain(`/m/${memorialId}/curate?person=${personId}`);

    // Filtering to her shows only her photographs…
    const filtered = await curate(memorialId, { person: personId });
    expect(textOf(filtered).replace(/\s+/g, ' ')).toMatch(/Showing the 2 photos with Ruth in them/);
    expect(textOf(filtered)).toMatch(/Show everyone again/);

    // …and the nudge is about her, in a decade of her life.
    expect(textOf(filtered)).toMatch(/No photos of Ruth from their thirties/);
  });

  it('stops suggesting a group the family says is not one person', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    photo(memorialId, 'ruth-1962.jpg', '1960s');
    photo(memorialId, 'ruth-1988.jpg', '1980s');
    await captureRedirect(() => startFaceGroupingAction(form({ memorialId })));
    await findFaces(memorialId);

    const cluster = listFaceClusters(db(), memorialId)[0];
    await captureRedirect(() =>
      dismissClusterAction(form({ memorialId, clusterId: cluster?.clusterId as string })),
    );

    const text = textOf(await curate(memorialId));
    expect(text).not.toMatch(/These look like the same person/);
    // The photographs themselves are untouched.
    expect(listWhere(db(), mediaAssets, eq(mediaAssets.memorialId, memorialId))).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('improving a photograph', () => {
  /** Stands in for the worker having finished: the copy exists, unchosen. */
  function pretendImproved(assetId: string): void {
    insertOne(db(), assetVariants, {
      assetId,
      kind: 'enhanced2400',
      blobKey: `memorial/x/variant/enhanced2400/${assetId}.jpg`,
      mime: 'image/jpeg',
      byteSize: 2048,
    });
    updateById(db(), mediaAssets, assetId, {
      enhanceState: 'ready',
      enhanceEngine: 'sharp',
      enhanceNote:
        'We brought the light back. The original is untouched, and you can go back to it at any time.',
      enhancedAt: Date.now(),
    });
  }

  it('offers it in the photo’s own menu, and queues the work when asked', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    const assetId = photo(memorialId, 'ruth-1974.jpg', '1970s');
    process.env['FACE_ENGINE'] = 'off';

    expect(textOf(await curate(memorialId))).toMatch(/Improve this photo/);

    await captureRedirect(() => improvePhotoAction(form({ memorialId, assetId })));

    const queued = listWhere(db(), jobs, eq(jobs.memorialId, memorialId));
    expect(queued.map((job) => job.type)).toEqual(['enhance-asset']);
    expect(textOf(await curate(memorialId))).toMatch(/Working on it/);
  });

  it('shows a before and a after, and serves the original until somebody chooses', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    const assetId = photo(memorialId, 'ruth-1974.jpg', '1970s');
    process.env['FACE_ENGINE'] = 'off';
    pretendImproved(assetId);

    const screen = await curate(memorialId);
    const text = textOf(screen);
    expect(text).toMatch(/Before and after/);
    expect(text).toMatch(/As it arrived/);
    expect(text).toMatch(/Gently improved/);
    expect(text).toMatch(/Use the improved version/);
    expect(text).toMatch(/The original is always kept/);

    const urls = urlsOf(screen);
    expect(urls).toContain(`/api/assets/${assetId}?variant=web1600`);
    expect(urls).toContain(`/api/assets/${assetId}?variant=enhanced2400`);
    // The card itself still shows the plain thumbnail: nothing has been chosen.
    expect(urls).toContain(`/api/assets/${assetId}?variant=thumb320`);
    expect(text).not.toMatch(new RegExp(ENHANCED_BADGE));
  });

  it('changes what is served when the family says they prefer it, and back again', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    const assetId = photo(memorialId, 'ruth-1974.jpg', '1970s');
    process.env['FACE_ENGINE'] = 'off';
    pretendImproved(assetId);

    await captureRedirect(() => useImprovedAction(form({ memorialId, assetId })));

    const chosen = await curate(memorialId);
    expect(textOf(chosen)).toMatch(new RegExp(ENHANCED_BADGE));
    expect(textOf(chosen)).toMatch(/Keep the original/);
    expect(urlsOf(chosen)).toContain(`/api/assets/${assetId}?variant=enhanced2400`);

    await captureRedirect(() => keepOriginalAction(form({ memorialId, assetId })));

    const reverted = await curate(memorialId);
    expect(textOf(reverted)).not.toMatch(new RegExp(ENHANCED_BADGE));
    expect(textOf(reverted)).toMatch(/Use the improved version/);
    // The improved copy is still on disk — changing your mind twice is ordinary.
    expect(
      listWhere(db(), assetVariants, eq(assetVariants.assetId, assetId)).map((v) => v.kind),
    ).toContain('enhanced2400');
  });
});
