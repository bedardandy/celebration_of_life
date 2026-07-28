/**
 * The photo journey, headless, end to end.
 *
 * An organiser opens the collect screen and gets a link → a cousin opens that
 * link with no account, types a first name, and posts the fixture set (HEIC,
 * sideways, two shots of one moment, a blurry one, and a file that is not a
 * photo) → the worker's ingest runs → the curation grid shows what it should,
 * and every photo behind it is refused to anybody who should not see it.
 *
 * It is written as one continuous story on purpose: the failures that matter
 * here are the ones between the pieces.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-collect-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'collect.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'collect-test-secret';
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
const { POST: upload } = await import('./api/upload/route');
const { GET: getAsset } = await import('./api/assets/[assetId]/route');
const { saveNameAction, saveNotesAction, saveMemoryAction } = await import('./c/[token]/actions');
const {
  addNoteAction,
  chooseRepresentativeAction,
  toggleApprovalAction,
  toggleHiddenAction,
  toggleWhoIsThisAction,
} = await import('./m/[memorialId]/curate/actions');
const { createAskAction, revokeLinkAction } = await import('./m/[memorialId]/photos/actions');
const ContributorLanding = (await import('./c/[token]/page')).default;
const {
  DevConsoleTransport,
  SESSION_COOKIE,
  buildCurationView,
  ensureCollectionLink,
  ingestAsset,
  listCollectionLinks,
  noteCountsByAsset,
  recoverShareableToken,
  setMailTransport,
} = await import('@col/core');
const {
  and,
  claimNext,
  complete,
  eq,
  isNull,
  jobPayload,
  listWhere,
  mediaAssets,
  memoryNotes,
  participants,
} = await import('@col/db');
const { getBlobStore } = await import('@col/storage');

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'photos',
);

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
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function createMemorial(decedentName = 'Ruth Kelleher') {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName,
        organizerName: 'Anne Kelleher',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  const memorialId = destination.split('/')[2] as string;
  const link = ensureCollectionLink(db(), memorialId);
  const token = recoverShareableToken(link) as string;
  // Keep the organiser's session cookie so the tests can put it back on.
  const session = cookieJar.get(SESSION_COOKIE)?.value as string;
  return { memorialId, token, tokenRow: link, session };
}

function signIn(session: string): void {
  cookieJar.set(SESSION_COOKIE, session);
}

async function fixtureFile(name: string, type?: string): Promise<File> {
  const bytes = await readFile(path.join(FIXTURES, name));
  const mime = type ?? (name.endsWith('.heic') ? 'image/heic' : 'image/jpeg');
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

async function postUpload(
  token: string,
  files: File[],
  options: { accept?: string; cookie?: string } = {},
): Promise<Response> {
  const body = new FormData();
  body.append('token', token);
  for (const file of files) body.append('files', file);

  const headers = new Headers();
  headers.set('accept', options.accept ?? 'application/json');
  if (options.cookie) headers.set('cookie', options.cookie);

  return upload(new Request('http://localhost:3000/api/upload', { method: 'POST', body, headers }));
}

/** Run the queue the way the worker does, using the same ingest code path. */
async function drainIngest(): Promise<number> {
  let ran = 0;
  for (;;) {
    const job = claimNext(db(), { workerId: 'test-worker', leaseMs: 30_000 });
    if (!job) return ran;
    const payload = jobPayload(job);
    if (payload.type !== 'ingest-asset') {
      complete(db(), job.id, null);
      continue;
    }
    const result = await ingestAsset(db(), getBlobStore(), {
      assetId: payload.assetId,
      blobKey: payload.blobKey,
    });
    complete(db(), job.id, result);
    ran += 1;
  }
}

const assetsOf = (memorialId: string) =>
  listWhere(
    db(),
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
  );

const FIXTURE_SET = [
  '01-portrait.jpg',
  '04-garden.jpg',
  '05-garden-near-duplicate.jpg',
  '06-blurry.jpg',
  '07-sideways.jpg',
  '08-phone.heic',
  '09-not-a-photo.jpg',
];

describe('the contributor page', () => {
  it('opens for anybody with the link, with no account and no session', async () => {
    const { token } = await createMemorial('Ruth Kelleher');
    cookieJar.clear(); // nobody is signed in to anything

    const screen = await ContributorLanding({ params: Promise.resolve({ token }) });
    expect(screen.props.title).toBe("You're helping remember Ruth Kelleher.");
  });

  it('shows a gentle page, not an error, once the link is turned off', async () => {
    const { memorialId, token, tokenRow, session } = await createMemorial();
    signIn(session);
    await captureRedirect(() => revokeLinkAction(form({ memorialId, tokenId: tokenRow.id })));
    cookieJar.clear();

    const screen = await ContributorLanding({ params: Promise.resolve({ token }) });
    expect(screen.props.reason).toBe('revoked');
    // The component that renders it says what to do, and blames nobody.
    const { LINK_CLOSED_COPY } = await import('@col/core');
    expect(LINK_CLOSED_COPY.revoked.title).toBe('This link is no longer active');
    expect(LINK_CLOSED_COPY.revoked.body).toMatch(/check with the family/i);
  });

  it('refuses uploads through a link that has been turned off', async () => {
    const { memorialId, token, tokenRow, session } = await createMemorial();
    signIn(session);
    await captureRedirect(() => revokeLinkAction(form({ memorialId, tokenId: tokenRow.id })));
    cookieJar.clear();

    const response = await postUpload(token, [await fixtureFile('01-portrait.jpg')]);
    expect(response.status).toBe(403);
    expect(assetsOf(memorialId)).toHaveLength(0);
  });
});

describe('upload → ingest → curate', () => {
  it('carries a fixture set all the way to a curation grid', async () => {
    const { memorialId, token, session } = await createMemorial('Ruth Kelleher');
    cookieJar.clear();

    // The cousin types a first name. That is the entire sign-up.
    const afterName = await captureRedirect(() => saveNameAction(form({ token, name: 'Siobhán' })));
    expect(afterName).toBe(`/c/${token}/add`);
    const contributor = listWhere(
      db(),
      participants,
      and(eq(participants.memorialId, memorialId), eq(participants.role, 'contributor')),
    )[0];
    expect(contributor?.displayName).toBe('Siobhán');

    const files = await Promise.all(FIXTURE_SET.map((name) => fixtureFile(name)));
    const response = await postUpload(token, files, { cookie: cookieJar.header() });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { added: number; assets: { id: string }[] };
    expect(body.added).toBe(FIXTURE_SET.length);

    // Every upload is attributed to the person who typed their name.
    const uploaded = assetsOf(memorialId);
    expect(uploaded).toHaveLength(FIXTURE_SET.length);
    expect(uploaded.every((a) => a.uploadedByParticipantId === contributor?.id)).toBe(true);
    expect(uploaded.every((a) => a.ingestState === 'uploaded')).toBe(true);
    // Blob keys live under the memorial prefix, so a purge is one call.
    expect(uploaded.every((a) => a.blobKey.startsWith(`memorial/${memorialId}/`))).toBe(true);

    expect(await drainIngest()).toBe(FIXTURE_SET.length);

    const processed = assetsOf(memorialId);
    expect(processed.filter((a) => a.ingestState === 'ready')).toHaveLength(6);
    expect(processed.filter((a) => a.ingestState === 'failed')).toHaveLength(1);

    // The sideways one came out upright.
    const sideways = processed.find((a) => a.originalFilename === '07-sideways.jpg');
    expect(sideways?.width).toBe(480);
    expect(sideways?.height).toBe(640);

    // The HEIC has JPEG variants a browser can show.
    const heic = processed.find((a) => a.originalFilename === '08-phone.heic');
    expect(heic?.ingestState).toBe('ready');

    const view = buildCurationView({
      assets: processed,
      contributorNames: new Map([[contributor?.id as string, 'Siobhán']]),
      noteCounts: noteCountsByAsset(db(), memorialId),
    });

    // Two shots of one moment are one card, with the other frame to hand.
    const collapsed = view.groups.flatMap((g) => g.cards).find((c) => c.alternates.length > 0);
    expect(collapsed?.alternates).toHaveLength(1);
    expect(view.counts.duplicatesCollapsed).toBe(1);

    // Blurry is flagged, never removed.
    const blurry = view.groups.flatMap((g) => g.cards).find((c) => c.blurry);
    expect(blurry?.badge).toMatch(/still lovely/i);
    expect(blurry?.hidden).toBe(false);

    // The file that was not a photo says so, in plain words.
    const broken = view.groups.flatMap((g) => g.cards).find((c) => c.problem);
    expect(broken?.problem).toMatch(/could not open this file as a photo/i);

    // No dates on the fixtures, so everything sits in "when was this?".
    expect(view.groups.map((g) => g.label)).toEqual(['When was this?']);
    expect(view.counts.photos).toBe(7);
    expect(view.counts.contributors).toBe(1);
    expect(view.summary).toBe('7 photos from 1 person, 0 approved.');

    // And the dashboard's checklist counts the same photos.
    const { computeChecklist } = await import('@col/core');
    const checklist = computeChecklist(
      { id: memorialId, intakeCompletedAt: null },
      { photos: view.counts.photos, memories: 0 },
    );
    expect(checklist.cards[0]?.statusLine).toContain('7 photos');

    // Curating: tap to keep, tap again to change your mind.
    const first = view.groups[0]?.cards[0]?.asset.id as string;
    signIn(session);
    await captureRedirect(() => toggleApprovalAction(form({ memorialId, assetId: first })));
    expect(assetsOf(memorialId).find((a) => a.id === first)?.curationState).toBe('approved');
    await captureRedirect(() => toggleApprovalAction(form({ memorialId, assetId: first })));
    expect(assetsOf(memorialId).find((a) => a.id === first)?.curationState).toBe('pending');

    await captureRedirect(() => toggleHiddenAction(form({ memorialId, assetId: first })));
    expect(assetsOf(memorialId).find((a) => a.id === first)?.curationState).toBe('hidden');
    await captureRedirect(() => toggleHiddenAction(form({ memorialId, assetId: first })));

    await captureRedirect(() => toggleWhoIsThisAction(form({ memorialId, assetId: first })));
    expect(assetsOf(memorialId).find((a) => a.id === first)?.needsIdentification).toBe(true);

    await captureRedirect(() =>
      addNoteAction(form({ memorialId, assetId: first, note: 'Ask Tom who is on the left.' })),
    );
    expect(noteCountsByAsset(db(), memorialId).get(first)).toBe(1);

    // Switching which frame of the burst is shown.
    const groupMembers = assetsOf(memorialId).filter((a) => a.dupeGroupId != null);
    const other = groupMembers.find((a) => !a.dupeRepresentative) as (typeof groupMembers)[number];
    await captureRedirect(() =>
      chooseRepresentativeAction(form({ memorialId, assetId: other.id })),
    );
    const after = assetsOf(memorialId).filter((a) => a.dupeGroupId != null);
    expect(after.filter((a) => a.dupeRepresentative)).toHaveLength(1);
    expect(after.find((a) => a.dupeRepresentative)?.id).toBe(other.id);

    // And a re-ingest does not undo the family's choice.
    await ingestAsset(db(), getBlobStore(), { assetId: other.id });
    expect(assetsOf(memorialId).find((a) => a.dupeRepresentative)?.id).toBe(other.id);
  });

  it('takes notes about the batch that just arrived, and one memory at the end', async () => {
    const { memorialId, token } = await createMemorial('Ruth Kelleher');
    cookieJar.clear();
    await captureRedirect(() => saveNameAction(form({ token, name: 'Mary' })));

    const response = await postUpload(token, [await fixtureFile('01-portrait.jpg')], {
      cookie: cookieJar.header(),
    });
    expect(response.status).toBe(201);
    // The response sets a short cookie naming the batch; that is what lets the
    // next screen ask about these photos and not last Tuesday's. Store it the
    // way a browser would.
    const setCookie = response.headers.get('set-cookie') ?? '';
    const [pair] = setCookie.split(';');
    const [cookieName, cookieValue] = (pair ?? '').split('=');
    expect(cookieName).toMatch(/^col_b_/);
    cookieJar.set(cookieName as string, decodeURIComponent(cookieValue ?? ''));

    const assetId = assetsOf(memorialId)[0]?.id as string;
    expect(decodeURIComponent(cookieValue ?? '')).toContain(assetId);

    const afterNotes = await captureRedirect(() =>
      saveNotesAction(form({ token, [`note-${assetId}`]: 'The garden in Cork, about 1998.' })),
    );
    expect(afterNotes).toBe(`/c/${token}/memory`);

    const afterMemory = await captureRedirect(() =>
      saveMemoryAction(form({ token, memory: 'She always answered the phone singing.' })),
    );
    expect(afterMemory).toBe(`/c/${token}/thanks`);

    const notes = listWhere(db(), memoryNotes, eq(memoryNotes.memorialId, memorialId));
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.assetId === assetId)?.text).toContain('Cork');
    const memory = notes.find((n) => n.promptSlug === 'unforgettable-moment');
    expect(memory?.text).toContain('singing');
    expect(memory?.authorName).toBe('Mary');
    // Contributions wait to be read rather than appearing as approved facts.
    expect(notes.every((n) => n.approved === false)).toBe(true);
  });

  it('answers a browser with no JavaScript with a redirect, not JSON', async () => {
    const { memorialId, token } = await createMemorial();
    cookieJar.clear();

    const response = await postUpload(token, [await fixtureFile('02-beach.jpg')], {
      accept: 'text/html,application/xhtml+xml',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain(`/c/${token}/notes?added=1`);
    expect(assetsOf(memorialId)).toHaveLength(1);
  });

  it('turns away a file that is not a photo or a video, and keeps the rest', async () => {
    const { memorialId, token } = await createMemorial();
    cookieJar.clear();

    const notes = new File([new Uint8Array(Buffer.from('shopping list'))], 'list.txt', {
      type: 'text/plain',
    });
    const response = await postUpload(token, [notes, await fixtureFile('02-beach.jpg')]);
    const body = (await response.json()) as { added: number; rejected: { reason: string }[] };
    expect(body.added).toBe(1);
    expect(body.rejected[0]?.reason).toMatch(/photos and videos/i);
    expect(assetsOf(memorialId)).toHaveLength(1);
  });
});

describe('the delegation composer', () => {
  it('makes a scoped link whose landing page carries the personal ask', async () => {
    const { memorialId, session } = await createMemorial('Ruth Kelleher');
    signIn(session);

    await captureRedirect(() =>
      createAskAction(
        form({ memorialId, name: 'Aunt Mary', template: 'younger-years', deadline: '2026-08-05' }),
      ),
    );

    const links = listCollectionLinks(
      db(),
      (await import('@col/db')).getById(
        db(),
        (await import('@col/db')).memorials,
        memorialId,
      ) as never,
    );
    const ask = links.find((l) => l.row.kind === 'contributor');
    expect(ask?.label).toBe('Aunt Mary');
    expect(ask?.ask.deadlineLine).toContain('Wednesday');

    cookieJar.clear();
    const screen = await ContributorLanding({
      params: Promise.resolve({ token: ask?.token as string }),
    });
    expect(screen.props.title).toBe("You're helping remember Ruth Kelleher.");
  });

  it('asks again for a name rather than making a nameless link', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    const destination = await captureRedirect(() =>
      createAskAction(form({ memorialId, name: '  ', template: 'anything' })),
    );
    expect(destination).toContain('ask=name');
  });
});

describe('serving a photo', () => {
  async function readyAsset() {
    const { memorialId, token, session } = await createMemorial();
    cookieJar.clear();
    await postUpload(token, [await fixtureFile('01-portrait.jpg')]);
    await drainIngest();
    const assetId = assetsOf(memorialId)[0]?.id as string;
    return { memorialId, token, session, assetId };
  }

  const request = (assetId: string, query = '') =>
    new Request(`http://localhost:3000/api/assets/${assetId}${query}`);

  const params = (assetId: string) => ({ params: Promise.resolve({ assetId }) });

  it('refuses a stranger with no session and no link', async () => {
    const { assetId } = await readyAsset();
    cookieJar.clear();
    const response = await getAsset(request(assetId, '?variant=thumb320'), params(assetId));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves the organiser, with private immutable caching and an ETag', async () => {
    const { assetId, session } = await readyAsset();
    signIn(session);

    const response = await getAsset(request(assetId, '?variant=thumb320'), params(assetId));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const etag = response.headers.get('etag') as string;
    expect(etag).toContain(assetId);

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // A JPEG, as promised: SOI marker.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    const again = await getAsset(
      new Request(`http://localhost:3000/api/assets/${assetId}?variant=thumb320`, {
        headers: { 'if-none-match': etag },
      }),
      params(assetId),
    );
    expect(again.status).toBe(304);
  });

  it('serves a contributor holding the link for that memorial', async () => {
    const { assetId, token } = await readyAsset();
    cookieJar.clear();
    const response = await getAsset(
      request(assetId, `?variant=thumb320&token=${encodeURIComponent(token)}`),
      params(assetId),
    );
    expect(response.status).toBe(200);
  });

  it('refuses a perfectly valid link belonging to another family', async () => {
    const { assetId } = await readyAsset();
    const other = await createMemorial('Someone Else');
    cookieJar.clear();

    const response = await getAsset(
      request(assetId, `?variant=thumb320&token=${encodeURIComponent(other.token)}`),
      params(assetId),
    );
    expect(response.status).toBe(403);
  });

  it('refuses an organiser signed in to another memorial', async () => {
    const { assetId } = await readyAsset();
    const other = await createMemorial('Someone Else');
    signIn(other.session);

    const response = await getAsset(request(assetId, '?variant=thumb320'), params(assetId));
    expect(response.status).toBe(403);
  });

  it('serves the sizes the grid and the renderer ask for', async () => {
    const { assetId, session } = await readyAsset();
    signIn(session);
    for (const variant of ['thumb320', 'web1600', 'render2400']) {
      const response = await getAsset(request(assetId, `?variant=${variant}`), params(assetId));
      expect(response.status, variant).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('falls back rather than showing a broken frame for an unknown size', async () => {
    const { assetId, session } = await readyAsset();
    signIn(session);
    const response = await getAsset(request(assetId, '?variant=enormous'), params(assetId));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it('says nothing at all about a photo that does not exist', async () => {
    const response = await getAsset(request('01890000-0000-7000-8000-000000000000'), {
      params: Promise.resolve({ assetId: '01890000-0000-7000-8000-000000000000' }),
    });
    expect(response.status).toBe(403);
  });
});
