/**
 * Ingest, as domain logic.
 *
 * The worker handler around this is deliberately thin — leases, retries,
 * logging — because everything that decides what a photo *becomes* belongs
 * where it can be tested without a queue: the blob in, the variants and the row
 * out, and one honest answer when the file turns out not to be a photo.
 *
 * The store is taken as a parameter and typed structurally, so this file has no
 * opinion about whether the bytes live on a disk or in S3.
 */
import type { Readable } from 'node:stream';
import { assetVariants, eq, getById, insertOne, mediaAssets, updateById, type Db } from '@col/db';
import {
  eraGuess,
  isVideoMime,
  processPhoto,
  UnreadableMediaError,
  type RenderedVariant,
} from '@col/media';
import { regroupDuplicates } from './dedupe';

/** The slice of BlobStore ingest needs. Structural, so @col/storage stays out. */
export type IngestStore = {
  getStream(key: string): Promise<Readable>;
  put(key: string, body: Buffer, mime: string): Promise<unknown>;
};

export type IngestOutcome = {
  assetId: string;
  state: 'ready' | 'failed' | 'skipped';
  variants: string[];
  dupeGroups?: number;
  reason?: string;
};

/** Keys stay under `memorial/{id}/` so a hard delete is one prefix removal. */
export function variantBlobKey(memorialId: string, assetId: string, variant: string): string {
  return `memorial/${memorialId}/variant/${variant}/${assetId}.jpg`;
}

async function readAll(store: IngestStore, key: string): Promise<Buffer> {
  const stream = await store.getStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export type IngestOptions = {
  /** Called between the slow steps, so a worker can renew its lease. */
  onProgress?: () => void;
};

export async function ingestAsset(
  db: Db,
  store: IngestStore,
  input: { assetId: string; blobKey?: string },
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const beat = options.onProgress ?? (() => {});
  const asset = getById(db, mediaAssets, input.assetId);

  // Not an error: a family can remove a photo between upload and ingest, and
  // the job should notice rather than resurrect it.
  if (!asset || asset.deletedAt != null) {
    return { assetId: input.assetId, state: 'skipped', variants: [], reason: 'gone' };
  }

  updateById(db, mediaAssets, asset.id, { ingestState: 'processing', ingestError: null });

  // Video is kept exactly as it arrived. Somebody sent it for a reason, and the
  // slideshow phases can decide what to do with it later.
  if (isVideoMime(asset.mime)) {
    updateById(db, mediaAssets, asset.id, { ingestState: 'ready', ingestError: null });
    return { assetId: asset.id, state: 'ready', variants: [] };
  }

  // A missing blob is treated as transient: the caller retries.
  const bytes = await readAll(store, input.blobKey || asset.blobKey);
  beat();

  let processed;
  try {
    processed = await processPhoto(bytes);
  } catch (err) {
    if (err instanceof UnreadableMediaError) {
      const reason = `${err.message} Nothing else was affected.`;
      updateById(db, mediaAssets, asset.id, {
        ingestState: 'failed',
        ingestError: reason,
        // Out of the way, not deleted: the family can still see what happened.
        curationState: 'rejected',
      });
      return { assetId: asset.id, state: 'failed', variants: [], reason };
    }
    throw err;
  }
  beat();

  const written = await writeVariants(db, store, asset.memorialId, asset.id, processed.variants);

  updateById(db, mediaAssets, asset.id, {
    width: processed.width,
    height: processed.height,
    capturedAt: processed.capturedAt ?? null,
    eraGuess: processed.era ?? eraGuess(processed.capturedAt) ?? null,
    phash: processed.phash,
    qualityScore: processed.quality.qualityScore,
    blurScore: processed.quality.blurScore,
    ingestState: 'ready',
    ingestError: null,
  });

  // Regroup after every photo: the other half of a burst often arrives later,
  // from somebody else.
  const { groupCount } = regroupDuplicates(db, asset.memorialId);

  return { assetId: asset.id, state: 'ready', variants: written, dupeGroups: groupCount };
}

/**
 * Variants are replaced wholesale rather than merged, so a re-ingest after a
 * bug fix leaves no half-old set behind. The unique (asset, kind) index makes
 * that a delete-then-insert.
 */
async function writeVariants(
  db: Db,
  store: IngestStore,
  memorialId: string,
  assetId: string,
  variants: readonly RenderedVariant[],
): Promise<string[]> {
  db.delete(assetVariants).where(eq(assetVariants.assetId, assetId)).run();

  const written: string[] = [];
  for (const variant of variants) {
    const key = variantBlobKey(memorialId, assetId, variant.name);
    await store.put(key, variant.data, variant.mime);
    insertOne(db, assetVariants, {
      assetId,
      kind: variant.name,
      blobKey: key,
      mime: variant.mime,
      width: variant.width,
      height: variant.height,
      byteSize: variant.byteSize,
    });
    written.push(variant.name);
  }
  return written;
}
