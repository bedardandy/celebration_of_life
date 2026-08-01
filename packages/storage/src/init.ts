/**
 * Choosing where blobs live, once, at boot.
 *
 * `getBlobStore()` is synchronous everywhere it is called — a route handler
 * serving a photograph should not be awaiting a factory — so the choice is made
 * before any of those calls happen and installed process-wide. The web app does
 * it from Next's instrumentation hook; the worker does it before it claims its
 * first job.
 *
 * Local disk is the default and stays the default. Nothing about this product
 * requires object storage; S3 is for a deployment that has outgrown one machine
 * or wants somebody else's backups.
 */
import type { BlobStore } from './blob-store';
import { LocalDiskStore, setBlobStore } from './local-disk-store';
import { s3StoreFromEnv } from './s3-store';

export type StorageDriver = 'local' | 's3';

export function storageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  const configured = env['STORAGE_DRIVER']?.trim().toLowerCase();
  if (!configured || configured === 'local') return 'local';
  if (configured === 's3') return 's3';
  throw new Error(`STORAGE_DRIVER=${JSON.stringify(configured)} is not one of: local, s3.`);
}

/**
 * Install the store this process should use, and hand it back.
 *
 * Safe to call more than once; the second call is what a hot reload does.
 */
export async function initBlobStore(env: NodeJS.ProcessEnv = process.env): Promise<BlobStore> {
  const store: BlobStore =
    storageDriver(env) === 's3' ? await s3StoreFromEnv(env) : new LocalDiskStore();
  setBlobStore(store);
  return store;
}
