/**
 * Looking for the same face across a family's photographs.
 *
 * Three rules shape this handler, and like photo analysis they are about
 * consent rather than correctness:
 *
 *  1. It only ever runs because an organizer pressed a button. Nothing enqueues
 *     it on upload and nothing enqueues it on a schedule.
 *  2. Nothing leaves the machine. The engine is local by construction — there
 *     is no adapter here that could call a face API even if somebody wanted one
 *     — and what is stored is deleted with the memorial.
 *  3. When no engine is installed the job finishes as **skipped, not failed**.
 *     A deployment without models is a supported deployment; retrying it three
 *     times and then marking a job failed would be noise in the log and a red
 *     mark against a family who did nothing wrong.
 */
import { facePendingAssets, recordFaceDetections, regroupFaces, listFaceClusters } from '@col/core';
import {
  assetVariants,
  eq,
  getById,
  listWhere,
  mediaAssets,
  type Db,
  type MediaAsset,
} from '@col/db';
import { resolveFaceEngine, type FaceEngine } from '@col/media';
import { getBlobStore, type BlobStore } from '@col/storage';
import { defineHandler } from './types';

/** Faces are found on the review-size copy: big enough, and already upright. */
export const FACE_VARIANT = 'web1600';

let engineOverride: FaceEngine | undefined;
let storeOverride: BlobStore | undefined;

/** Injectable for tests; production resolves from the environment at run time. */
export function setFaceEngine(engine: FaceEngine | undefined): void {
  engineOverride = engine;
}

export function setFacesBlobStore(store: BlobStore | undefined): void {
  storeOverride = store;
}

function store(): BlobStore {
  return storeOverride ?? getBlobStore();
}

export type DetectFacesOutcome = {
  status: 'done' | 'skipped' | 'nothing-to-do';
  engine?: string;
  scanned: number;
  faces: number;
  clusters: number;
  unreadable: number;
  reason?: string;
};

export const detectFacesHandler = defineHandler('detect-faces', async (ctx) => {
  const { db, payload, log } = ctx;

  const engine = engineOverride ?? resolveFaceEngine();
  if (!engine) {
    return skipped('No face engine is configured on this machine (FACE_ENGINE is off).');
  }
  const status = await engine.available();
  if (!status.available) return skipped(status.reason, engine.id);

  const assets = selectAssets(db, payload.memorialId, payload.assetIds, payload.redo);
  if (assets.length === 0) {
    return {
      status: 'nothing-to-do',
      engine: engine.id,
      scanned: 0,
      faces: 0,
      clusters: listFaceClusters(db, payload.memorialId).length,
      unreadable: 0,
    } satisfies DetectFacesOutcome;
  }

  let faces = 0;
  let unreadable = 0;

  for (const asset of assets) {
    if (ctx.signal.aborted) break;
    ctx.heartbeat();

    const bytes = await readBytes(db, asset);
    if (!bytes) {
      // A photograph still being ingested is not an error; the next pass gets it.
      unreadable += 1;
      continue;
    }

    const found = await engine.detect(bytes, {
      filename: asset.originalFilename,
      assetId: asset.id,
    });
    recordFaceDetections(db, {
      memorialId: payload.memorialId,
      assetId: asset.id,
      engine: engine.id,
      faces: found,
    });
    faces += found.length;
  }

  // Grouping is over the whole memorial, not over this batch: the other half of
  // a face's photographs usually arrived last Tuesday.
  const grouped = regroupFaces(db, payload.memorialId);

  log.info('faces grouped', {
    memorialId: payload.memorialId,
    engine: engine.id,
    scanned: assets.length,
    faces,
    clusters: grouped.clusters,
  });

  return {
    status: 'done',
    engine: engine.id,
    scanned: assets.length,
    faces,
    clusters: grouped.clusters,
    unreadable,
  } satisfies DetectFacesOutcome;
});

function skipped(reason: string, engine?: string): DetectFacesOutcome {
  return {
    status: 'skipped',
    ...(engine ? { engine } : {}),
    scanned: 0,
    faces: 0,
    clusters: 0,
    unreadable: 0,
    reason,
  };
}

function selectAssets(
  db: Db,
  memorialId: string,
  assetIds: string[] | undefined,
  redo: boolean,
): MediaAsset[] {
  if (!assetIds || assetIds.length === 0) return facePendingAssets(db, memorialId, redo);
  return assetIds
    .map((id) => getById(db, mediaAssets, id))
    .filter(
      (asset): asset is MediaAsset =>
        asset !== undefined &&
        asset.memorialId === memorialId &&
        asset.deletedAt == null &&
        asset.mime.startsWith('image/') &&
        asset.ingestState === 'ready',
    );
}

async function readBytes(db: Db, asset: MediaAsset): Promise<Buffer | undefined> {
  const variants = listWhere(db, assetVariants, eq(assetVariants.assetId, asset.id), 10);
  const chosen =
    variants.find((variant) => variant.kind === FACE_VARIANT) ??
    variants.find((variant) => variant.kind === 'render2400');
  const key = chosen?.blobKey ?? asset.blobKey;

  try {
    const stream = await store().getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  }
}
