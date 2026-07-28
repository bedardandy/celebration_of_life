import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat as fsStat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  BlobNotFoundError,
  InvalidBlobKeyError,
  sanitizeKey,
  sanitizePrefix,
  type BlobStat,
  type BlobStore,
  type PutBody,
  type PutResult,
} from './blob-store';
import { resolveFromRoot } from './paths';

export const DEFAULT_STORAGE_DIR = './data/blobs';

/** Relative paths resolve against the repo root, never the cwd. See ./paths.ts. */
export function resolveStorageDir(dir?: string): string {
  return resolveFromRoot(dir ?? process.env.STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
}

/**
 * Filesystem-backed blob store for development and single-machine deployments.
 * Keys map 1:1 to relative paths under `root`, which is why key sanitisation is
 * not optional here — it is the containment boundary.
 */
export class LocalDiskStore implements BlobStore {
  readonly id = 'local-disk';
  readonly root: string;

  constructor(root?: string) {
    this.root = resolveStorageDir(root);
  }

  /** Sanitise, then re-verify the resolved path really is inside the root. */
  private resolve(key: string): string {
    const safe = sanitizeKey(key);
    const full = path.resolve(this.root, safe);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (full !== this.root && !full.startsWith(rootWithSep)) {
      throw new InvalidBlobKeyError(key, 'resolved outside the storage root');
    }
    return full;
  }

  getPath(key: string): string {
    return this.resolve(key);
  }

  async put(key: string, body: PutBody, mime: string): Promise<PutResult> {
    const safe = sanitizeKey(key);
    const full = this.resolve(safe);
    await mkdir(path.dirname(full), { recursive: true });

    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      await pipeline(Readable.from(buf), createWriteStream(full));
      return { key: safe, byteSize: buf.byteLength, mime };
    }

    await pipeline(body, createWriteStream(full));
    const s = await fsStat(full);
    return { key: safe, byteSize: s.size, mime };
  }

  async getStream(key: string): Promise<Readable> {
    const full = this.resolve(key);
    if (!(await this.exists(key))) throw new BlobNotFoundError(sanitizeKey(key));
    return createReadStream(full);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const s = await fsStat(this.resolve(key));
      return s.isFile();
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<BlobStat | undefined> {
    try {
      const s = await fsStat(this.resolve(key));
      if (!s.isFile()) return undefined;
      return { key: sanitizeKey(key), byteSize: s.size, modifiedAt: Math.round(s.mtimeMs) };
    } catch {
      return undefined;
    }
  }

  /** Every key under `prefix`, relative to the root, sorted for determinism. */
  async list(prefix: string): Promise<string[]> {
    const safePrefix = sanitizePrefix(prefix);
    const base = this.resolve(safePrefix);
    const found: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          found.push(path.relative(this.root, full).split(path.sep).join('/'));
        }
      }
    };

    const s = await fsStat(base).catch(() => undefined);
    if (!s) return [];
    if (s.isFile()) return [safePrefix];
    await walk(base);
    return found.sort();
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Hard delete under a prefix. This is what makes "delete everything" a real
   * promise rather than a hidden flag, so it removes the directory too.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    const base = this.resolve(sanitizePrefix(prefix));
    await rm(base, { recursive: true, force: true });
    return keys.length;
  }
}

/** Process-wide store. Later phases swap this for S3Store via env. */
let singleton: BlobStore | undefined;

export function getBlobStore(): BlobStore {
  singleton ??= new LocalDiskStore();
  return singleton;
}

export function setBlobStore(store: BlobStore | undefined): void {
  singleton = store;
}
