/**
 * Ingest: whatever arrived → something we can show.
 *
 * This handler is the reason the upload endpoint can be fast and the reason a
 * contributor on a train can close the tab. The work itself lives in
 * `@col/core` (`ingestAsset`), where it can be tested without a queue; what is
 * here is the part that belongs to the queue:
 *
 *  - the blob is missing, the disk is busy, something transient — throw, and
 *    the job retries with backoff.
 *  - the file is not a photo at all — `ingestAsset` records that on the row in
 *    words a family could read, and this returns successfully. Retrying a
 *    corrupt file three times only delays telling the truth about it, and one
 *    bad file must never take the worker down while forty good ones wait behind
 *    it.
 */
import { ingestAsset, type IngestStore } from '@col/core';
import { getBlobStore, type BlobStore } from '@col/storage';
import { defineHandler } from './types';

/** Injectable for tests; production uses the process-wide store. */
let storeOverride: BlobStore | undefined;

export function setIngestBlobStore(store: BlobStore | undefined): void {
  storeOverride = store;
}

function store(): IngestStore {
  return storeOverride ?? getBlobStore();
}

export const ingestAssetHandler = defineHandler('ingest-asset', async (ctx) => {
  const { db, payload, log } = ctx;

  const outcome = await ingestAsset(
    db,
    store(),
    { assetId: payload.assetId, blobKey: payload.blobKey },
    // Decoding a 48-megapixel HEIC takes a while; keep the lease alive.
    { onProgress: () => void ctx.heartbeat() },
  );

  if (outcome.state === 'failed') {
    log.warn('unreadable upload parked', { assetId: outcome.assetId, reason: outcome.reason });
  } else if (outcome.state === 'ready') {
    log.info('photo ready', {
      assetId: outcome.assetId,
      variants: outcome.variants.length,
      dupeGroups: outcome.dupeGroups ?? 0,
    });
  }

  return outcome;
});
