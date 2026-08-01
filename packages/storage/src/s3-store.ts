/**
 * S3-compatible blob storage.
 *
 * The same interface as the local disk, and deliberately no more: there are
 * still no public URLs, no presigned links that outlive a revoked viewing link,
 * and no bucket policy anybody has to get right. Every read goes through the
 * app, is auth-checked there, and is streamed. A bucket for this product should
 * be private, and nothing here will work any differently if it is.
 *
 * `getPath` is deliberately absent. It exists on the local store because ffmpeg
 * and Remotion want real files; a caller that needs one from S3 must copy the
 * object into scratch first, and the render handler already does exactly that
 * (`materialise`). Advertising a path we cannot honour would break renders in a
 * way that only shows up in production.
 *
 * Works against AWS S3, MinIO, Backblaze B2, Cloudflare R2 and Wasabi — set
 * S3_ENDPOINT for anything that is not AWS, and S3_FORCE_PATH_STYLE=1 for MinIO.
 */
import { Readable } from 'node:stream';
import {
  BlobNotFoundError,
  sanitizeKey,
  sanitizePrefix,
  type BlobStat,
  type BlobStore,
  type PutBody,
  type PutResult,
} from './blob-store';

/* -------------------------------------------------------------------------- */
/* the slice of the SDK this file uses                                         */
/* -------------------------------------------------------------------------- */

/**
 * Structural types rather than imports from `@aws-sdk/client-s3`.
 *
 * The SDK is an optional dependency: a single-machine deployment on the local
 * disk store should not have to install eighty packages to start. Typing the
 * three calls we make keeps this file compiling whether or not the SDK is
 * present, and keeps the unit tests honest — they pass a fake client that
 * satisfies exactly this and nothing more.
 */
export type S3ClientLike = {
  send(command: unknown): Promise<unknown>;
};

export type S3CommandBundle = {
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectsCommand: new (input: Record<string, unknown>) => unknown;
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
};

export type S3StoreOptions = {
  client: S3ClientLike;
  commands: S3CommandBundle;
  bucket: string;
  /** Everything this app writes lives under here. Useful for a shared bucket. */
  keyPrefix?: string;
};

/** S3 refuses more than a thousand keys in one delete. */
const DELETE_BATCH = 1000;

/* -------------------------------------------------------------------------- */

export class S3Store implements BlobStore {
  readonly id = 's3';
  readonly bucket: string;
  private readonly prefix: string;

  constructor(private readonly options: S3StoreOptions) {
    this.bucket = options.bucket;
    const raw = options.keyPrefix?.replace(/^\/+|\/+$/g, '') ?? '';
    this.prefix = raw ? `${raw}/` : '';
  }

  /** Our key → the object key in the bucket. */
  private objectKey(key: string): string {
    return `${this.prefix}${sanitizeKey(key)}`;
  }

  /** …and back, so `list` returns keys the rest of the product recognises. */
  private ourKey(objectKey: string): string {
    return objectKey.startsWith(this.prefix) ? objectKey.slice(this.prefix.length) : objectKey;
  }

  async put(key: string, body: PutBody, mime: string): Promise<PutResult> {
    const safe = sanitizeKey(key);
    const { PutObjectCommand } = this.options.commands;

    // A stream has no length until it has been read, and S3 wants one. Renders
    // are the only streamed put in this product and they are hundreds of
    // megabytes, so they are handed over as a stream with the length the caller
    // already knows — buffering one in memory is how a worker falls over on the
    // day everybody needs it.
    const payload = Buffer.isBuffer(body)
      ? body
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : body;

    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(safe),
        Body: payload,
        ContentType: mime,
      }),
    );

    if (Buffer.isBuffer(payload)) return { key: safe, byteSize: payload.byteLength, mime };
    const stat = await this.stat(safe);
    return { key: safe, byteSize: stat?.byteSize ?? 0, mime };
  }

  async getStream(key: string): Promise<Readable> {
    const { GetObjectCommand } = this.options.commands;
    try {
      const result = (await this.options.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      )) as { Body?: unknown };
      const body = result.Body;
      if (!body) throw new BlobNotFoundError(sanitizeKey(key));
      if (body instanceof Readable) return body;
      // A web stream, which is what the SDK hands back on some runtimes.
      return Readable.fromWeb(body as never);
    } catch (error) {
      if (isNotFound(error)) throw new BlobNotFoundError(sanitizeKey(key));
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== undefined;
  }

  async stat(key: string): Promise<BlobStat | undefined> {
    const { HeadObjectCommand } = this.options.commands;
    try {
      const result = (await this.options.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      )) as { ContentLength?: number; LastModified?: Date };
      return {
        key: sanitizeKey(key),
        byteSize: result.ContentLength ?? 0,
        modifiedAt: result.LastModified ? result.LastModified.getTime() : 0,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const { ListObjectsV2Command } = this.options.commands;
    const safePrefix = sanitizePrefix(prefix);
    const found: string[] = [];
    let token: string | undefined;

    do {
      const page = (await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}${safePrefix}`,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )) as {
        Contents?: { Key?: string }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };

      for (const object of page.Contents ?? []) {
        if (object.Key) found.push(this.ourKey(object.Key));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return found.sort();
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = this.options.commands;
    await this.options.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    );
  }

  /**
   * Hard delete under a prefix.
   *
   * This is the promise the whole privacy posture rests on — "delete is real" —
   * so it pages through every key rather than stopping at the first thousand,
   * and returns how many objects actually went.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const { DeleteObjectsCommand } = this.options.commands;
    const keys = await this.list(prefix);
    if (keys.length === 0) return 0;

    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      await this.options.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: this.objectKey(key) })) },
        }),
      );
    }
    return keys.length;
  }
}

/** S3 signals "no such object" in three different ways depending on the call. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/* -------------------------------------------------------------------------- */
/* building one from the environment                                           */
/* -------------------------------------------------------------------------- */

export type S3EnvConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  keyPrefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

/**
 * Read the S3 settings, or say precisely which one is missing. Separate from
 * construction so the settings can be validated at boot without the SDK being
 * loaded, and so this is testable without any network at all.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3EnvConfig {
  const bucket = env['S3_BUCKET']?.trim();
  if (!bucket) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET to be set. See docs/production.md.');
  }
  const accessKeyId = env['S3_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = env['S3_SECRET_ACCESS_KEY']?.trim();
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error(
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both left unset to use the machine’s own credentials.',
    );
  }

  return {
    bucket,
    region: env['S3_REGION']?.trim() || 'us-east-1',
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] === '1',
    ...(env['S3_ENDPOINT']?.trim() ? { endpoint: env['S3_ENDPOINT'].trim() } : {}),
    ...(env['S3_KEY_PREFIX']?.trim() ? { keyPrefix: env['S3_KEY_PREFIX'].trim() } : {}),
    ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
  };
}

/**
 * Build a store from the environment, loading the SDK only now.
 *
 * The dynamic import is what keeps `@aws-sdk/client-s3` optional: a deployment
 * on the local disk store never reaches this line, and one that does gets a
 * sentence about `pnpm add` rather than a module-not-found stack trace.
 */
export async function s3StoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<S3Store> {
  const config = s3ConfigFromEnv(env);

  let sdk: typeof import('@aws-sdk/client-s3');
  try {
    sdk = (await import('@aws-sdk/client-s3')) as typeof import('@aws-sdk/client-s3');
  } catch (error) {
    throw new Error(
      'STORAGE_DRIVER=s3 needs the @aws-sdk/client-s3 package: pnpm add @aws-sdk/client-s3.',
      { cause: error },
    );
  }

  const client = new sdk.S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }
      : {}),
  });

  return new S3Store({
    client: client as unknown as S3ClientLike,
    commands: sdk as unknown as S3CommandBundle,
    bucket: config.bucket,
    ...(config.keyPrefix ? { keyPrefix: config.keyPrefix } : {}),
  });
}
