/**
 * "Improve this photo", through the queue.
 *
 * The assertions here are the promises the screen makes: the original bytes are
 * byte-for-byte what they were, the plain render copy is untouched, the
 * improved copy is an extra thing beside them, and nothing serves it until
 * somebody says so. Everything runs against a synthetically faded photograph so
 * "better" is a measurement rather than an opinion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  assetVariants,
  createTestDb,
  eq,
  getById,
  insertOne,
  listWhere,
  mediaAssets,
  memorials,
  newId,
  type Db,
  type Memorial,
} from '@col/db';
import {
  acceptEnhancement,
  assetInputsFor,
  enhancementView,
  requestEnhancement,
  revertEnhancement,
  servingVariant,
  variantsByAsset,
  ENHANCED_BADGE,
} from '@col/core';
import { measureForEnhancement } from '@col/media';
import { LocalDiskStore } from '@col/storage';
import { setEnhanceBlobStore, setRestorer } from './index';
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
  workerId: 'enhance-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

let db: Db;
let memorial: Memorial;
let workdir: string;
let store: LocalDiskStore;

beforeEach(() => {
  db = createTestDb();
  memorial = insertOne(db, memorials, { decedentName: 'Ruth Kelleher' });
  workdir = mkdtempSync(path.join(tmpdir(), 'col-enhance-'));
  store = new LocalDiskStore(workdir);
  setEnhanceBlobStore(store);
});

afterEach(() => {
  setEnhanceBlobStore(undefined);
  setRestorer(undefined);
  db.$sqlite.close();
  rmSync(workdir, { recursive: true, force: true });
});

/** A print that has been in a drawer since 1974: flat, and the colour gone. */
async function fadedPrint(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">` +
      `<rect width="640" height="480" fill="rgb(150,120,90)"/>` +
      `<circle cx="200" cy="200" r="110" fill="rgb(215,175,145)"/>` +
      `<rect x="340" y="120" width="230" height="260" fill="rgb(95,85,75)"/>` +
      `</svg>`,
    'utf8',
  );
  const scene = await sharp(svg).png().toBuffer();
  return sharp(scene)
    .linear(0.28, 95)
    .modulate({ saturation: 0.35 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function uploadedPhoto(): Promise<{ assetId: string; original: Buffer }> {
  const assetId = newId();
  const original = await fadedPrint();
  const key = `memorial/${memorial.id}/original/${assetId}.jpg`;
  await store.put(key, original, 'image/jpeg');

  insertOne(db, mediaAssets, {
    id: assetId,
    memorialId: memorial.id,
    originalFilename: 'ruth-1974.jpg',
    mime: 'image/jpeg',
    byteSize: original.byteLength,
    blobKey: key,
    ingestState: 'ready',
    curationState: 'approved',
    width: 640,
    height: 480,
  });

  // The render copy ingest would have made.
  const renderKey = `memorial/${memorial.id}/variant/render2400/${assetId}.jpg`;
  await store.put(renderKey, original, 'image/jpeg');
  insertOne(db, assetVariants, {
    assetId,
    kind: 'render2400',
    blobKey: renderKey,
    mime: 'image/jpeg',
    width: 640,
    height: 480,
    byteSize: original.byteLength,
  });

  return { assetId, original };
}

async function read(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await store.getStream(key)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

const run = () => drain({ db, config, logger: silent });

/* -------------------------------------------------------------------------- */

describe('enhance-asset', () => {
  it('makes an improved copy beside the original, and changes nothing else', async () => {
    const { assetId, original } = await uploadedPhoto();

    const job = requestEnhancement(db, memorial.id, assetId);
    expect(job).toBeDefined();
    expect(getById(db, mediaAssets, assetId)?.enhanceState).toBe('queued');

    const [result] = await run();
    expect(result?.status).toBe('done');

    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.enhanceState).toBe('ready');
    expect(asset?.enhanceEngine).toBe('sharp');
    expect(asset?.enhanceNote).toMatch(/original is untouched/i);
    // Not accepted by making it: the family has not looked at it yet.
    expect(asset?.enhanceAcceptedAt).toBeNull();

    const variants = listWhere(db, assetVariants, eq(assetVariants.assetId, assetId));
    expect(variants.map((v) => v.kind).sort()).toEqual(['enhanced2400', 'render2400']);

    // The original is byte-for-byte what arrived.
    expect(await read(asset?.blobKey as string)).toEqual(original);

    const enhanced = variants.find((v) => v.kind === 'enhanced2400');
    const before = await measureForEnhancement(original);
    const after = await measureForEnhancement(await read(enhanced?.blobKey as string));
    // Measurably more of the picture visible — about half again as much range
    // — rather than "looks nicer", which a test cannot judge.
    expect(after.contrastRange).toBeGreaterThan(before.contrastRange * 1.4);
    expect(after.saturation).toBeGreaterThan(before.saturation);
    // Same photograph, same shape.
    expect(enhanced?.width).toBe(640);
    expect(enhanced?.height).toBe(480);
    // Under the memorial's own prefix, so a hard delete reaches it like
    // everything else.
    expect(enhanced?.blobKey.startsWith(`memorial/${memorial.id}/`)).toBe(true);
  });

  it('serves the original until the family says they prefer the other one', async () => {
    const { assetId } = await uploadedPhoto();
    requestEnhancement(db, memorial.id, assetId);
    await run();

    const asset = () => getById(db, mediaAssets, assetId)!;
    const variants = () => listWhere(db, assetVariants, eq(assetVariants.assetId, assetId));

    expect(servingVariant(asset(), variants())).toBe('render2400');
    expect(enhancementView(db, asset()).badge).toBeUndefined();

    acceptEnhancement(db, memorial.id, assetId);
    expect(servingVariant(asset(), variants())).toBe('enhanced2400');
    expect(enhancementView(db, asset()).badge).toBe(ENHANCED_BADGE);
    expect(enhancementView(db, asset()).accepted).toBe(true);

    revertEnhancement(db, memorial.id, assetId);
    expect(servingVariant(asset(), variants())).toBe('render2400');
    expect(asset().enhanceState).toBe('ready');
    // The improved copy is still there — changing your mind twice is ordinary.
    expect(variants().some((v) => v.kind === 'enhanced2400')).toBe(true);
  });

  it('changes which copy the slideshow is built from', async () => {
    const { assetId } = await uploadedPhoto();
    requestEnhancement(db, memorial.id, assetId);
    await run();

    const assets = listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id));
    expect(assetInputsFor(assets, variantsByAsset(db, assets))[0]?.variant).toBe('render2400');

    acceptEnhancement(db, memorial.id, assetId);
    const after = listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id));
    expect(assetInputsFor(after, variantsByAsset(db, after))[0]?.variant).toBe('enhanced2400');
  });

  it('refuses to accept an improvement that does not exist yet', async () => {
    const { assetId } = await uploadedPhoto();
    expect(acceptEnhancement(db, memorial.id, assetId)).toBeUndefined();
    expect(getById(db, mediaAssets, assetId)?.enhanceAcceptedAt).toBeNull();
  });

  it('parks a file it cannot open, in words a family could read', async () => {
    const assetId = newId();
    const key = `memorial/${memorial.id}/original/${assetId}.jpg`;
    await store.put(key, Buffer.from('this is not a photograph at all\n'), 'image/jpeg');
    insertOne(db, mediaAssets, {
      id: assetId,
      memorialId: memorial.id,
      mime: 'image/jpeg',
      byteSize: 32,
      blobKey: key,
      ingestState: 'ready',
    });

    requestEnhancement(db, memorial.id, assetId);
    const [result] = await run();

    // Successfully finished, not retried three times: the file will not change.
    expect(result?.status).toBe('done');
    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.enhanceState).toBe('failed');
    expect(asset?.enhanceNote).toMatch(/exactly as it was/i);
    expect(listWhere(db, assetVariants, eq(assetVariants.assetId, assetId))).toHaveLength(0);
  });

  it('leaves a photograph alone when the restorer on this machine cannot run', async () => {
    const { assetId } = await uploadedPhoto();
    setRestorer({
      id: 'pretend-esrgan',
      available: async () => ({ available: false, reason: 'pretend-esrgan is not installed' }),
      restore: async () => {
        throw new Error('never called');
      },
    });

    requestEnhancement(db, memorial.id, assetId);
    const [result] = await run();

    expect(result?.status).toBe('done');
    expect(
      listWhere(db, assetVariants, eq(assetVariants.assetId, assetId)).map((v) => v.kind),
    ).toEqual(['render2400']);
  });
});
