/**
 * The S3 store, against a client that is entirely in this file.
 *
 * No network, no bucket, no credentials: the fake below implements exactly the
 * six commands the store issues, which is also the argument for the store
 * depending on a structural type rather than the SDK. What is being tested is
 * the part that would be expensive to get wrong in production — key prefixing,
 * pagination, and the fact that `deletePrefix` really removes everything.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { BlobNotFoundError, type BlobStore } from './blob-store';
import { S3Store, s3ConfigFromEnv, type S3ClientLike, type S3CommandBundle } from './s3-store';

/* --- a bucket in a Map ----------------------------------------------------- */

type Command = { kind: string; input: Record<string, unknown> };

function command(kind: string) {
  return class {
    kind = kind;
    constructor(public input: Record<string, unknown>) {}
  } as unknown as new (input: Record<string, unknown>) => unknown;
}

const commands: S3CommandBundle = {
  GetObjectCommand: command('get'),
  PutObjectCommand: command('put'),
  HeadObjectCommand: command('head'),
  DeleteObjectCommand: command('delete'),
  DeleteObjectsCommand: command('deleteMany'),
  ListObjectsV2Command: command('list'),
};

class NotFound extends Error {
  override name = 'NotFound';
  $metadata = { httpStatusCode: 404 };
}

class FakeBucket implements S3ClientLike {
  readonly objects = new Map<string, { body: Buffer; mime: string; modified: Date }>();
  readonly calls: Command[] = [];
  /** Pretend the service pages at this many keys, as a real one does at 1000. */
  pageSize = 1000;

  async send(raw: unknown): Promise<unknown> {
    const cmd = raw as Command;
    this.calls.push(cmd);
    const key = String(cmd.input['Key'] ?? '');

    switch (cmd.kind) {
      case 'put':
        this.objects.set(key, {
          body: Buffer.isBuffer(cmd.input['Body'])
            ? (cmd.input['Body'] as Buffer)
            : Buffer.from('streamed'),
          mime: String(cmd.input['ContentType'] ?? ''),
          modified: new Date(1_700_000_000_000),
        });
        return {};

      case 'head': {
        const object = this.objects.get(key);
        if (!object) throw new NotFound('not found');
        return { ContentLength: object.body.byteLength, LastModified: object.modified };
      }

      case 'get': {
        const object = this.objects.get(key);
        if (!object) throw new NotFound('not found');
        return { Body: Readable.from(object.body) };
      }

      case 'delete':
        this.objects.delete(key);
        return {};

      case 'deleteMany': {
        const del = cmd.input['Delete'] as { Objects: { Key: string }[] };
        for (const object of del.Objects) this.objects.delete(object.Key);
        return {};
      }

      case 'list': {
        const prefix = String(cmd.input['Prefix'] ?? '');
        const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const from = cmd.input['ContinuationToken']
          ? all.indexOf(String(cmd.input['ContinuationToken']))
          : 0;
        const page = all.slice(from, from + this.pageSize);
        const next = all[from + this.pageSize];
        return {
          Contents: page.map((k) => ({ Key: k })),
          IsTruncated: next !== undefined,
          ...(next ? { NextContinuationToken: next } : {}),
        };
      }

      default:
        throw new Error(`unexpected command ${cmd.kind}`);
    }
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

let bucket: FakeBucket;
let store: S3Store;

beforeEach(() => {
  bucket = new FakeBucket();
  store = new S3Store({ client: bucket, commands, bucket: 'tributes' });
});

/* -------------------------------------------------------------------------- */

describe('putting and getting', () => {
  it('round-trips bytes with their content type', async () => {
    const result = await store.put('memorial/m1/render/a.mp4', Buffer.from('video'), 'video/mp4');
    expect(result).toEqual({ key: 'memorial/m1/render/a.mp4', byteSize: 5, mime: 'video/mp4' });

    const body = await readAll(await store.getStream('memorial/m1/render/a.mp4'));
    expect(body.toString()).toBe('video');
    expect(bucket.objects.get('memorial/m1/render/a.mp4')?.mime).toBe('video/mp4');
  });

  it('reports a missing object the same way the local disk does', async () => {
    await expect(store.getStream('memorial/m1/nope.mp4')).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await store.stat('memorial/m1/nope.mp4')).toBeUndefined();
    expect(await store.exists('memorial/m1/nope.mp4')).toBe(false);
  });

  it('refuses a key that tries to climb out of the prefix', async () => {
    await expect(store.put('../secrets/x', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /traversal/,
    );
  });

  it('never claims a local path, because there is not one', () => {
    // Callers probe for `getPath` before using it (the render handler copies
    // into scratch when it is absent); advertising one we cannot honour would
    // break renders only in production.
    expect((store as BlobStore).getPath).toBeUndefined();
  });

  it('hands a stream straight through rather than buffering a render', async () => {
    const result = await store.put(
      'memorial/m1/render/big.mp4',
      Readable.from(Buffer.from('streamed')),
      'video/mp4',
    );
    const put = bucket.calls.find((c) => c.kind === 'put');
    expect(put?.input['Body']).toBeInstanceOf(Readable);
    // Length comes from a HEAD afterwards rather than from reading it twice.
    expect(result.byteSize).toBe(8);
  });
});

describe('a shared bucket', () => {
  it('writes under the configured prefix and hides it from callers', async () => {
    const prefixed = new S3Store({
      client: bucket,
      commands,
      bucket: 'tributes',
      keyPrefix: 'prod/',
    });

    await prefixed.put('memorial/m1/original/a.jpg', Buffer.from('jpeg'), 'image/jpeg');
    expect([...bucket.objects.keys()]).toEqual(['prod/memorial/m1/original/a.jpg']);
    // The rest of the product never sees the prefix.
    expect(await prefixed.list('memorial/m1')).toEqual(['memorial/m1/original/a.jpg']);
    expect(await readAll(await prefixed.getStream('memorial/m1/original/a.jpg'))).toHaveLength(4);
  });
});

describe('listing and hard delete', () => {
  async function fill(count: number) {
    for (let i = 0; i < count; i += 1) {
      await store.put(
        `memorial/m1/original/photo-${String(i).padStart(4, '0')}.jpg`,
        Buffer.from('x'),
        'image/jpeg',
      );
    }
    await store.put('memorial/m2/original/other.jpg', Buffer.from('x'), 'image/jpeg');
  }

  it('pages through everything rather than stopping at the first page', async () => {
    bucket.pageSize = 3;
    await fill(10);
    const keys = await store.list('memorial/m1');
    expect(keys).toHaveLength(10);
    expect(keys[0]).toBe('memorial/m1/original/photo-0000.jpg');
  });

  it('removes every object under the prefix, and only those', async () => {
    bucket.pageSize = 4;
    await fill(9);

    const removed = await store.deletePrefix('memorial/m1');

    expect(removed).toBe(9);
    expect(await store.list('memorial/m1')).toEqual([]);
    // Another family's photographs are untouched.
    expect(await store.list('memorial/m2')).toEqual(['memorial/m2/original/other.jpg']);
  });

  it('batches deletes, because the service refuses more than a thousand at once', async () => {
    await fill(5);
    await store.deletePrefix('memorial/m1');
    const deletes = bucket.calls.filter((c) => c.kind === 'deleteMany');
    expect(deletes).toHaveLength(1);
    expect((deletes[0]?.input['Delete'] as { Objects: unknown[] }).Objects).toHaveLength(5);
  });

  it('says nothing went when there was nothing there', async () => {
    expect(await store.deletePrefix('memorial/never')).toBe(0);
  });
});

describe('reading the settings', () => {
  it('needs a bucket, by name', () => {
    expect(() => s3ConfigFromEnv({})).toThrow(/S3_BUCKET/);
  });

  it('defaults the region and honours a non-AWS endpoint', () => {
    const config = s3ConfigFromEnv({
      S3_BUCKET: 'tributes',
      S3_ENDPOINT: 'https://s3.example.test',
      S3_FORCE_PATH_STYLE: '1',
    });
    expect(config).toMatchObject({
      bucket: 'tributes',
      region: 'us-east-1',
      endpoint: 'https://s3.example.test',
      forcePathStyle: true,
    });
    expect(config.accessKeyId).toBeUndefined();
  });

  it('will not accept half a set of credentials', () => {
    expect(() => s3ConfigFromEnv({ S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toThrow(
      /must be set together/,
    );
  });
});
