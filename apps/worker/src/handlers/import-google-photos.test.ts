/**
 * The Google Photos import, end to end, with the network replaced by a table.
 *
 * Nothing in this file can reach Google: every call goes through a `fetch`
 * written here, and the tests assert on what was asked for as much as on what
 * came back — the scope, the `=d` suffix that asks for the original file, the
 * bearer header, and the session being cleaned up afterwards.
 *
 * The case that matters most is the unhappy one. Google's download links expire
 * about an hour after they are listed, and a family who picked twenty
 * photographs and got eighteen must be told exactly that, in a sentence that
 * says what to do next.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  eq,
  getJob,
  insertOne,
  jobs,
  listWhere,
  mediaAssets,
  memorials,
  participants,
  enqueue,
  type Db,
  type Memorial,
  type Participant,
} from '@col/db';
import { latestGoogleImport, seal, GOOGLE_TOKEN_PURPOSE } from '@col/core';
import { LocalDiskStore } from '@col/storage';
import { setGoogleFetch, setImportBlobStore } from './index';
import { drain } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'import-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

const SECRET = 'import-test-secret';

let db: Db;
let memorial: Memorial;
let organizer: Participant;
let workdir: string;
let store: LocalDiskStore;
let calls: string[];

beforeEach(() => {
  process.env['SESSION_SECRET'] = SECRET;
  db = createTestDb();
  memorial = insertOne(db, memorials, { decedentName: 'Ruth Kelleher' });
  organizer = insertOne(db, participants, {
    memorialId: memorial.id,
    role: 'organizer',
    displayName: 'Anne',
  });
  workdir = mkdtempSync(path.join(tmpdir(), 'col-import-'));
  store = new LocalDiskStore(workdir);
  setImportBlobStore(store);
  calls = [];
});

afterEach(() => {
  setImportBlobStore(undefined);
  setGoogleFetch(undefined);
  db.$sqlite.close();
  rmSync(workdir, { recursive: true, force: true });
});

/* --- a Google that lives in this file ------------------------------------- */

type FakeOptions = {
  /** How many polls before the person has finished picking. */
  pollsBeforePicked?: number;
  photos?: number;
  /** Filenames whose download 403s, the way an expired baseUrl does. */
  expired?: string[];
  /** Include something that is not a photograph at all. */
  includeOther?: boolean;
};

const PIXEL = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function fakeGoogle(options: FakeOptions = {}): typeof fetch {
  const total = options.photos ?? 3;
  const expired = new Set(options.expired ?? []);
  let polls = 0;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url.includes('/v1/sessions/') && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (url.includes('/v1/sessions/')) {
      polls += 1;
      const picked = polls > (options.pollsBeforePicked ?? 0);
      return json({
        id: 'sess-1',
        pickerUri: 'https://photos.google.com/picker/sess-1',
        mediaItemsSet: picked,
        pollingConfig: { pollInterval: '2s', timeoutIn: '1800s' },
      });
    }

    if (url.includes('/v1/mediaItems')) {
      const items = Array.from({ length: total }, (_, i) => ({
        id: `item-${i + 1}`,
        createTime: '1975-06-04T10:00:00Z',
        type: 'PHOTO',
        mediaFile: {
          baseUrl: `https://lh3.googleusercontent.com/photo-${i + 1}`,
          mimeType: 'image/jpeg',
          filename: `ruth-${i + 1}.jpg`,
        },
      }));
      if (options.includeOther) {
        items.push({
          id: 'item-other',
          createTime: '1975-06-04T10:00:00Z',
          type: 'PHOTO',
          mediaFile: {
            baseUrl: 'https://lh3.googleusercontent.com/doc-1',
            mimeType: 'application/pdf',
            filename: 'order-of-service.pdf',
          },
        });
      }
      return json({ mediaItems: items });
    }

    if (url.includes('googleusercontent.com')) {
      const which = url.match(/photo-(\d+)/)?.[1];
      if (which && expired.has(`ruth-${which}.jpg`)) {
        return new Response('URL expired', { status: 403 });
      }
      return new Response(new Uint8Array(PIXEL), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }

    throw new Error(`unexpected call to ${url}`);
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function queueImport(options: { sealedToken?: string } = {}): string {
  const sealed =
    options.sealedToken ??
    seal(
      GOOGLE_TOKEN_PURPOSE,
      { accessToken: 'ya29.token', expiresAt: Date.now() + 3_600_000 },
      { secret: SECRET },
    );
  return enqueue(
    db,
    {
      type: 'import-google-photos',
      memorialId: memorial.id,
      sessionId: 'sess-1',
      sealedToken: sealed,
      participantId: organizer.id,
    },
    { memorialId: memorial.id },
  ).id;
}

const run = () => drain({ db, config, logger: silent });
const assetsOf = () => listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id));

/* -------------------------------------------------------------------------- */

describe('import-google-photos', () => {
  it('waits for the picking, downloads the originals, and files them like any upload', async () => {
    setGoogleFetch(fakeGoogle({ pollsBeforePicked: 1, photos: 3 }));
    queueImport();

    const results = await run();
    const importResult = results[0];
    expect(importResult?.status).toBe('done');

    const assets = assetsOf();
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.uploadedByParticipantId === organizer.id)).toBe(true);
    expect(assets.map((a) => a.originalFilename).sort()).toEqual([
      'ruth-1.jpg',
      'ruth-2.jpg',
      'ruth-3.jpg',
    ]);
    // The same path as a phone upload: an ingest job per photograph.
    const ingestJobs = listWhere(db, jobs, eq(jobs.type, 'ingest-asset'));
    expect(ingestJobs).toHaveLength(3);
    // And the bytes are in the blob store under the memorial's prefix.
    for (const asset of assets) {
      expect(asset.blobKey.startsWith(`memorial/${memorial.id}/`)).toBe(true);
      expect(await store.exists(asset.blobKey)).toBe(true);
    }

    // It polled until the person had finished, asked for the original file,
    // and tidied the session up afterwards.
    expect(
      calls.filter((c) => c.includes('/v1/sessions/sess-1') && c.startsWith('GET')),
    ).toHaveLength(2);
    expect(calls.some((c) => c.endsWith('photo-1=d'))).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
  });

  it('tells the family the truth when Google lets some links expire', async () => {
    setGoogleFetch(fakeGoogle({ photos: 5, expired: ['ruth-2.jpg', 'ruth-4.jpg'] }));
    queueImport();
    await run();

    expect(assetsOf()).toHaveLength(3);

    const status = latestGoogleImport(db, memorial.id);
    expect(status?.state).toBe('done');
    expect(status?.tally).toEqual({ added: 3, expired: 2, skipped: 0, total: 5 });
    expect(status?.message).toContain('We brought over 3 of 5');
    expect(status?.message).toMatch(/expire/);
    expect(status?.message).toMatch(/pick them again/);

    // Each expired one was tried twice before being given up on.
    expect(calls.filter((c) => c.endsWith('photo-2=d'))).toHaveLength(2);
  });

  it('leaves anything that is not a photo or a video where it was', async () => {
    setGoogleFetch(fakeGoogle({ photos: 2, includeOther: true }));
    queueImport();
    await run();

    expect(assetsOf()).toHaveLength(2);
    expect(latestGoogleImport(db, memorial.id)?.tally).toEqual({
      added: 2,
      expired: 0,
      skipped: 1,
      total: 3,
    });
  });

  it('refuses a token sealed by somebody else, and says to start again', async () => {
    setGoogleFetch(fakeGoogle());
    const forged = seal(
      GOOGLE_TOKEN_PURPOSE,
      { accessToken: 'stolen', expiresAt: Date.now() + 3_600_000 },
      { secret: 'a completely different secret' },
    );
    queueImport({ sealedToken: forged });

    const [result] = await run();
    expect(result?.status).toBe('done');
    const outcome = result?.status === 'done' ? (result.result as Record<string, unknown>) : {};
    expect(outcome['status']).toBe('skipped');
    expect(outcome['reason']).toBe('tampered');
    expect(assetsOf()).toHaveLength(0);
    // Nothing was fetched at all.
    expect(calls).toHaveLength(0);
  });

  it('takes the credential back out of the job row when it is finished with it', async () => {
    setGoogleFetch(fakeGoogle({ photos: 1 }));
    const jobId = queueImport();
    await run();

    const row = getJob(db, jobId);
    expect((row?.payload as { sealedToken?: string }).sealedToken).toBe('used');
  });

  it('says what the screen should say while an import is still running', () => {
    queueImport();
    const status = latestGoogleImport(db, memorial.id);
    expect(status?.state).toBe('waiting');
    expect(status?.message).toMatch(/bringing your photos over/i);
  });
});
