import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BlobNotFoundError,
  InvalidBlobKeyError,
  LocalDiskStore,
  blobKeys,
  sanitizeKey,
  sanitizePrefix,
} from './index';

let root: string;
let store: LocalDiskStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'col-blobs-'));
  store = new LocalDiskStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('sanitizeKey', () => {
  it('canonicalises valid keys', () => {
    expect(sanitizeKey('memorial/abc/original/x.jpg')).toBe('memorial/abc/original/x.jpg');
    expect(sanitizeKey('memorial//abc///x.jpg')).toBe('memorial/abc/x.jpg');
    expect(sanitizeKey('memorial/abc/x.jpg/')).toBe('memorial/abc/x.jpg');
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['../secrets.txt', 'traversal'],
    ['memorial/../../etc/passwd', 'nested traversal'],
    ['memorial/./x.jpg', 'dot segment'],
    ['memorial\\abc\\x.jpg', 'backslash'],
    ['C:/windows/system32', 'drive path'],
    ['memorial/abc/x y.jpg', 'space'],
    ['memorial/-leading-dash', 'segment starting with a dash'],
    ['memorial/abc/$(rm -rf).jpg', 'shell metacharacters'],
  ])('rejects %s (%s)', (key) => {
    expect(() => sanitizeKey(key)).toThrow(InvalidBlobKeyError);
  });

  it('rejects control characters', () => {
    expect(() => sanitizeKey('memorial/abc/x\u0000.jpg')).toThrow(InvalidBlobKeyError);
    expect(() => sanitizeKey('memorial/abc/x\n.jpg')).toThrow(InvalidBlobKeyError);
  });

  it('sanitizePrefix tolerates a trailing slash', () => {
    expect(sanitizePrefix('memorial/abc/')).toBe('memorial/abc');
    expect(() => sanitizePrefix('memorial/../abc/')).toThrow(InvalidBlobKeyError);
  });
});

describe('LocalDiskStore', () => {
  it('puts and gets a buffer', async () => {
    const key = blobKeys.original('m1', 'a1', 'jpg');
    const result = await store.put(key, Buffer.from('hello grief'), 'image/jpeg');
    expect(result).toEqual({ key, byteSize: 11, mime: 'image/jpeg' });

    const back = await readAll(await store.getStream(key));
    expect(back.toString()).toBe('hello grief');
  });

  it('puts from a stream', async () => {
    const key = 'memorial/m1/original/stream.bin';
    const result = await store.put(
      key,
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      'application/octet-stream',
    );
    expect(result.byteSize).toBe(6);
    expect((await readAll(await store.getStream(key))).toString()).toBe('abcdef');
  });

  it('creates intermediate directories', async () => {
    await store.put('memorial/m1/a/b/c/d.txt', Buffer.from('x'), 'text/plain');
    expect(existsSync(path.join(root, 'memorial/m1/a/b/c/d.txt'))).toBe(true);
  });

  it('overwrites cleanly (no leftover tail from a longer previous body)', async () => {
    const key = 'memorial/m1/original/x.txt';
    await store.put(key, Buffer.from('a much longer body'), 'text/plain');
    await store.put(key, Buffer.from('short'), 'text/plain');
    expect((await readAll(await store.getStream(key))).toString()).toBe('short');
  });

  it('throws BlobNotFoundError for a missing key', async () => {
    await expect(store.getStream('memorial/m1/nope.jpg')).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('reports exists/stat', async () => {
    const key = 'memorial/m1/original/x.txt';
    expect(await store.exists(key)).toBe(false);
    expect(await store.stat(key)).toBeUndefined();
    await store.put(key, Buffer.from('12345'), 'text/plain');
    expect(await store.exists(key)).toBe(true);
    expect((await store.stat(key))?.byteSize).toBe(5);
  });

  it('exposes a local path for ffmpeg/Remotion', async () => {
    const key = 'memorial/m1/render/r1.mp4';
    expect(store.getPath(key)).toBe(path.join(root, 'memorial/m1/render/r1.mp4'));
    expect(() => store.getPath('../escape.mp4')).toThrow(InvalidBlobKeyError);
  });

  it('lists keys under a prefix, sorted and root-relative', async () => {
    await store.put('memorial/m1/original/b.txt', Buffer.from('b'), 'text/plain');
    await store.put('memorial/m1/original/a.txt', Buffer.from('a'), 'text/plain');
    await store.put('memorial/m1/variant/thumb320/a.txt', Buffer.from('a'), 'text/plain');
    await store.put('memorial/m2/original/z.txt', Buffer.from('z'), 'text/plain');

    expect(await store.list('memorial/m1')).toEqual([
      'memorial/m1/original/a.txt',
      'memorial/m1/original/b.txt',
      'memorial/m1/variant/thumb320/a.txt',
    ]);
    expect(await store.list('memorial/m1/original/')).toHaveLength(2);
    expect(await store.list('memorial/nothing-here')).toEqual([]);
  });

  it('deletes a single key, idempotently', async () => {
    const key = 'memorial/m1/original/x.txt';
    await store.put(key, Buffer.from('x'), 'text/plain');
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('deletePrefix really removes everything for one memorial and nothing else', async () => {
    await store.put('memorial/m1/original/a.txt', Buffer.from('a'), 'text/plain');
    await store.put('memorial/m1/render/r.mp4', Buffer.from('mp4'), 'video/mp4');
    await store.put('memorial/m2/original/z.txt', Buffer.from('z'), 'text/plain');

    const removed = await store.deletePrefix(blobKeys.memorialPrefix('m1'));
    expect(removed).toBe(2);
    expect(await store.list('memorial/m1')).toEqual([]);
    expect(existsSync(path.join(root, 'memorial/m1'))).toBe(false);
    expect(await store.list('memorial/m2')).toHaveLength(1);
  });

  it('refuses to read or write outside the storage root', async () => {
    const outside = path.join(root, '..', `col-escape-${process.pid}.txt`);
    await writeFile(outside, 'secret');
    try {
      await expect(store.getStream('../' + path.basename(outside))).rejects.toBeInstanceOf(
        InvalidBlobKeyError,
      );
      await expect(
        store.put('../escaped.txt', Buffer.from('x'), 'text/plain'),
      ).rejects.toBeInstanceOf(InvalidBlobKeyError);
      expect(await readFile(outside, 'utf8')).toBe('secret');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('honours STORAGE_DIR when no root is given', () => {
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = path.join(root, 'from-env');
    try {
      expect(new LocalDiskStore().root).toBe(path.join(root, 'from-env'));
    } finally {
      if (previous === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previous;
    }
  });
});
