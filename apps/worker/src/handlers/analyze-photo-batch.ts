/**
 * Looking at a family's photographs.
 *
 * Three rules shape this handler, and they are all about consent rather than
 * correctness:
 *
 *  1. It only ever runs because an organizer pressed a button. There is no
 *     enqueue-on-upload path, because "we quietly sent your mother's photographs
 *     to a company" is not something a family should discover afterwards.
 *  2. A metered provider — one that bills per token, meaning the images leave
 *     this machine to a paid API — is gated on `aiConsentPhotoAnalysis`. Without
 *     it the job finishes as `skipped`, not as an error: nothing is broken, we
 *     simply were not given permission.
 *  3. What travels is the web1600 variant, never the original. Downsized and
 *     EXIF-stripped is the smallest thing that can answer the question.
 */
import { existsSync } from 'node:fs';
import {
  PhotoAnalysisBatchSchema,
  type PhotoAnalysis,
  type PhotoAnalysisEntry,
} from '@col/schemas';
import {
  and,
  assetVariants,
  eq,
  getById,
  isNull,
  mediaAssets,
  memorials,
  updateById,
  type Db,
  type MediaAsset,
} from '@col/db';
import {
  AiSchemaError,
  PHOTO_ANALYSIS_TASK,
  PHOTO_ANALYSIS_SYSTEM_PROMPT,
  buildPhotoAnalysisPrompt,
  generateObject,
  resolveProvider,
  type AiProvider,
  type PhotoAnalysisAsset,
} from '@col/ai';
import { getBlobStore } from '@col/storage';
import { defineHandler } from './types';

/** Variant we send. The original never leaves the machine. */
export const ANALYSIS_VARIANT = 'web1600';

export type AnalyzeBatchOutcome = {
  status: 'done' | 'skipped' | 'nothing-to-do';
  analyzed: number;
  skipped: number;
  reason?: string;
  providerId?: string;
};

/**
 * Photographs worth analysing: still here, actually a photo, not thrown away by
 * the family, and not already described.
 */
export function selectAnalyzableAssets(
  db: Db,
  memorialId: string,
  assetIds: string[],
): MediaAsset[] {
  const rows = db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)))
    .all();
  const wanted = new Set(assetIds);
  return rows.filter(
    (asset) =>
      wanted.has(asset.id) &&
      asset.mime.startsWith('image/') &&
      asset.curationState !== 'rejected' &&
      asset.analysis == null,
  );
}

/**
 * Consent, in one place.
 *
 * CLI and local providers are covered by the family's own subscription or run
 * on this machine; a metered API means the pictures go somewhere else, and that
 * needs a yes.
 */
export function analysisAllowed(
  provider: AiProvider,
  memorial: { aiConsentPhotoAnalysis: boolean },
): { allowed: true } | { allowed: false; reason: string } {
  if (provider.capabilities.costTier !== 'metered') return { allowed: true };
  if (memorial.aiConsentPhotoAnalysis) return { allowed: true };
  return {
    allowed: false,
    reason:
      `"${provider.id}" sends photographs to a paid API, and this memorial has not ` +
      'agreed to that. Turn on photo analysis consent, or use a local or CLI provider.',
  };
}

/** Where the web1600 variant actually is on disk. */
export function variantPath(
  db: Db,
  assetId: string,
  store: { getPath?: (key: string) => string },
): string | undefined {
  if (!store.getPath) return undefined;
  const variant = db
    .select()
    .from(assetVariants)
    .where(and(eq(assetVariants.assetId, assetId), eq(assetVariants.kind, ANALYSIS_VARIANT)))
    .limit(1)
    .all()[0];
  if (!variant) return undefined;
  const filePath = store.getPath(variant.blobKey);
  return existsSync(filePath) ? filePath : undefined;
}

/** Split into calls the provider will actually accept. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const safe = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safe) out.push(items.slice(i, i + safe));
  return out;
}

/**
 * EXIF beats a guess. When the file had a capture time we keep the year and
 * leave the model's era guess out; when it did not, the guess backfills.
 */
export function analysisWithEra(analysis: PhotoAnalysis, asset: MediaAsset): PhotoAnalysis {
  if (asset.capturedAt == null) return analysis;
  return { ...analysis, eraGuess: String(new Date(asset.capturedAt).getUTCFullYear()) };
}

export const analyzePhotoBatchHandler = defineHandler('analyze-photo-batch', async (ctx) => {
  const { memorialId, assetIds } = ctx.payload;
  const memorial = getById(ctx.db, memorials, memorialId);
  if (!memorial) throw new Error(`memorial ${memorialId} not found`);

  const candidates = selectAnalyzableAssets(ctx.db, memorialId, [...assetIds]);
  if (candidates.length === 0) {
    return { status: 'nothing-to-do', analyzed: 0, skipped: 0 } satisfies AnalyzeBatchOutcome;
  }

  const provider = resolveProvider('photo-analysis');
  const consent = analysisAllowed(provider, memorial);
  if (!consent.allowed) {
    ctx.log.warn('photo analysis skipped for consent', {
      memorialId,
      providerId: provider.id,
      count: candidates.length,
    });
    return {
      status: 'skipped',
      analyzed: 0,
      skipped: candidates.length,
      reason: consent.reason,
      providerId: provider.id,
    } satisfies AnalyzeBatchOutcome;
  }

  const store = getBlobStore();
  const withPaths = candidates
    .map((asset) => ({ asset, path: variantPath(ctx.db, asset.id, store) }))
    .filter((entry): entry is { asset: MediaAsset; path: string } => entry.path !== undefined);

  if (withPaths.length === 0) {
    // The ingest job has not produced variants yet. Not an error: the family's
    // photographs are fine, the derivative simply is not there yet.
    return {
      status: 'nothing-to-do',
      analyzed: 0,
      skipped: candidates.length,
      reason: `no ${ANALYSIS_VARIANT} variant on disk yet`,
      providerId: provider.id,
    } satisfies AnalyzeBatchOutcome;
  }

  const batchSize = Math.max(1, provider.capabilities.maxImagesPerCall);
  let analyzed = 0;

  for (const batch of chunk(withPaths, batchSize)) {
    if (ctx.signal.aborted) break;
    ctx.heartbeat();

    const assets: PhotoAnalysisAsset[] = batch.map((entry) => ({
      assetId: entry.asset.id,
      path: entry.path,
      ...(entry.asset.capturedAt == null
        ? {}
        : { capturedYear: new Date(entry.asset.capturedAt).getUTCFullYear() }),
    }));

    const prompt = buildPhotoAnalysisPrompt({
      subject: {
        fullName: memorial.decedentName,
        ...(memorial.decedentKnownAs ? { knownAs: memorial.decedentKnownAs } : {}),
        ...(memorial.birthYear ? { birthYear: memorial.birthYear } : {}),
        ...(memorial.deathYear ? { deathYear: memorial.deathYear } : {}),
      },
      assets,
    });

    let result;
    try {
      result = await generateObject(provider, PhotoAnalysisBatchSchema, {
        taskTag: PHOTO_ANALYSIS_TASK,
        messages: [
          { role: 'system', content: PHOTO_ANALYSIS_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...batch.map((entry) => ({
                type: 'image' as const,
                source: 'path' as const,
                path: entry.path,
              })),
            ],
          },
        ],
      });
    } catch (error) {
      // A batch the model could not describe is worth retrying later, but it
      // must not lose the batches that already worked.
      if (error instanceof AiSchemaError) {
        ctx.log.warn('photo batch came back unusable', {
          memorialId,
          count: batch.length,
          attempts: error.attempts,
        });
        continue;
      }
      throw error;
    }

    analyzed += storeAnalyses(ctx.db, batch, result.object.analyses);
  }

  return {
    status: 'done',
    analyzed,
    skipped: candidates.length - analyzed,
    providerId: provider.id,
  } satisfies AnalyzeBatchOutcome;
});

/** Write each analysis onto the row it belongs to, ignoring ids we did not ask about. */
export function storeAnalyses(
  db: Db,
  batch: readonly { asset: MediaAsset }[],
  entries: readonly PhotoAnalysisEntry[],
): number {
  const byId = new Map(batch.map((entry) => [entry.asset.id, entry.asset]));
  let written = 0;
  for (const entry of entries) {
    const asset = byId.get(entry.assetId);
    if (!asset) continue;
    updateById(db, mediaAssets, asset.id, { analysis: analysisWithEra(entry.analysis, asset) });
    written += 1;
  }
  return written;
}
