/**
 * Making the improved copy — and never touching the photograph.
 *
 * This handler writes exactly one new thing: an `enhanced2400` variant beside
 * the ones ingest already made. It does not overwrite the original, it does not
 * replace `render2400`, and it does not decide that the improved copy is the
 * one to use. That decision belongs to whoever is looking at the before and
 * after, which is why the row is left in 'ready' rather than 'accepted'.
 *
 * A photograph that cannot be improved is not a failure worth retrying three
 * times: it is recorded on the row in words a family could read, and the job
 * finishes successfully — exactly as ingest treats a file that is not a photo.
 */
import { variantBlobKey } from '@col/core';
import {
  and,
  assetVariants,
  eq,
  getById,
  insertOne,
  mediaAssets,
  updateById,
  type Db,
} from '@col/db';
import {
  ENHANCED_VARIANT,
  DERIVED_MIME,
  makeEnhancedCopy,
  resolveRestorer,
  UnreadableMediaError,
  type Restorer,
} from '@col/media';
import { getBlobStore, type BlobStore } from '@col/storage';
import { defineHandler } from './types';

let restorerOverride: Restorer | undefined;
let storeOverride: BlobStore | undefined;

export function setRestorer(restorer: Restorer | undefined): void {
  restorerOverride = restorer;
}

export function setEnhanceBlobStore(store: BlobStore | undefined): void {
  storeOverride = store;
}

function store(): BlobStore {
  return storeOverride ?? getBlobStore();
}

export type EnhanceOutcomeSummary = {
  status: 'done' | 'skipped' | 'failed';
  assetId: string;
  engine?: string;
  steps?: string[];
  /** The sentence shown beside the before and after. */
  summary?: string;
  reason?: string;
};

export const enhanceAssetHandler = defineHandler('enhance-asset', async (ctx) => {
  const { db, payload, log } = ctx;
  const asset = getById(db, mediaAssets, payload.assetId);

  if (!asset || asset.memorialId !== payload.memorialId || asset.deletedAt != null) {
    return {
      status: 'skipped',
      assetId: payload.assetId,
      reason: 'gone',
    } satisfies EnhanceOutcomeSummary;
  }
  if (!asset.mime.startsWith('image/')) {
    return {
      status: 'skipped',
      assetId: asset.id,
      reason: 'not a photograph',
    } satisfies EnhanceOutcomeSummary;
  }

  const restorer = restorerOverride ?? resolveRestorer();
  const availability = await restorer.available();
  if (!availability.available) {
    updateById(db, mediaAssets, asset.id, { enhanceState: 'failed' });
    return {
      status: 'skipped',
      assetId: asset.id,
      engine: restorer.id,
      reason: availability.reason,
    } satisfies EnhanceOutcomeSummary;
  }

  // A missing blob is transient — the job retries — but a file we cannot read
  // as a photograph is a fact about the file, and the family is told.
  const original = await readAll(store(), asset.blobKey);
  ctx.heartbeat();

  let result;
  try {
    result = await makeEnhancedCopy(original, restorer, { signal: ctx.signal });
  } catch (error) {
    if (error instanceof UnreadableMediaError || isImageError(error)) {
      updateById(db, mediaAssets, asset.id, {
        enhanceState: 'failed',
        enhanceEngine: restorer.id,
        enhanceNote:
          'We could not improve this one, and nothing about it has changed. It is exactly as it was.',
      });
      log.warn('photograph could not be improved', { assetId: asset.id });
      return {
        status: 'failed',
        assetId: asset.id,
        engine: restorer.id,
        reason: error instanceof Error ? error.message : String(error),
      } satisfies EnhanceOutcomeSummary;
    }
    throw error;
  }
  ctx.heartbeat();

  const key = variantBlobKey(asset.memorialId, asset.id, ENHANCED_VARIANT);
  await store().put(key, result.data, DERIVED_MIME);
  writeVariant(db, asset.id, key, result);

  updateById(db, mediaAssets, asset.id, {
    enhanceState: 'ready',
    enhanceEngine: restorer.id,
    enhanceNote: result.summary,
    enhancedAt: Date.now(),
  });

  log.info('improved copy ready', { assetId: asset.id, steps: result.steps.join(',') });

  return {
    status: 'done',
    assetId: asset.id,
    engine: restorer.id,
    steps: result.steps,
    summary: result.summary,
  } satisfies EnhanceOutcomeSummary;
});

function writeVariant(
  db: Db,
  assetId: string,
  key: string,
  result: { data: Buffer; width: number; height: number },
): void {
  // Replaced wholesale, so running it twice leaves one row and one blob.
  db.delete(assetVariants)
    .where(and(eq(assetVariants.assetId, assetId), eq(assetVariants.kind, ENHANCED_VARIANT)))
    .run();
  insertOne(db, assetVariants, {
    assetId,
    kind: ENHANCED_VARIANT,
    blobKey: key,
    mime: DERIVED_MIME,
    width: result.width,
    height: result.height,
    byteSize: result.data.byteLength,
  });
}

async function readAll(store: BlobStore, key: string): Promise<Buffer> {
  const stream = await store.getStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** sharp's own "this is not an image" message, which is not a typed error. */
function isImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('unsupported image format') ||
    message.includes('input buffer') ||
    message.includes('vipsjpeg') ||
    message.includes('image_size')
  );
}
