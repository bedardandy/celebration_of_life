/**
 * "Improve this photo", and the way back.
 *
 * The rule this file exists to enforce: **the original is never replaced.** An
 * enhancement is an extra variant beside the others, the family looks at both,
 * and until somebody says they prefer the improved one, every screen and every
 * render still serves the plain copy. Saying so afterwards — "keep the
 * original" — is one tap and puts everything back.
 *
 * That is not caution for its own sake. Families are extremely sensitive to a
 * face that no longer looks like the person, and they are often looking at the
 * last photograph anybody has.
 */
import {
  assetVariants,
  enqueue,
  eq,
  getById,
  inArray,
  listWhere,
  mediaAssets,
  updateById,
  type AssetVariant,
  type Db,
  type JobRow,
  type MediaAsset,
} from '@col/db';
import { ENHANCED_BADGE, ENHANCED_VARIANT } from '@col/media';

export { ENHANCED_BADGE, ENHANCED_VARIANT };

export const ENHANCE_COPY = {
  start: 'Improve this photo',
  working: 'Working on it. It will appear here in a moment.',
  compareTitle: 'Before and after',
  before: 'As it arrived',
  after: 'Gently improved',
  accept: 'Use the improved version',
  keep: 'Keep the original',
  reverted: 'Back to the original. The improved copy is still here if you change your mind.',
  failed:
    'We could not improve that one, and nothing about it has changed. It is exactly as it was.',
  /** Under the two buttons, every time. */
  reassurance: 'The original is always kept. You can change your mind at any time.',
} as const;

export type EnhancementState = MediaAsset['enhanceState'];

export type EnhancementView = {
  state: EnhancementState;
  /** True once there is something to compare. */
  hasCopy: boolean;
  accepted: boolean;
  /** What changed, in the restorer's own measured words. */
  note?: string;
  badge?: string;
};

export function enhancementView(db: Db, asset: MediaAsset): EnhancementView {
  const hasCopy = listWhere(db, assetVariants, eq(assetVariants.assetId, asset.id), 10).some(
    (variant) => variant.kind === ENHANCED_VARIANT,
  );
  const accepted = asset.enhanceAcceptedAt != null && hasCopy;
  return {
    state: asset.enhanceState,
    hasCopy,
    accepted,
    ...(asset.enhanceNote ? { note: asset.enhanceNote } : {}),
    ...(accepted ? { badge: ENHANCED_BADGE } : {}),
  };
}

/** Every photograph's enhancement state, in one query rather than N. */
export function enhancementViews(
  db: Db,
  assets: readonly MediaAsset[],
): Map<string, EnhancementView> {
  const out = new Map<string, EnhancementView>();
  if (assets.length === 0) return out;

  const withCopy = new Set(
    listWhere(
      db,
      assetVariants,
      inArray(
        assetVariants.assetId,
        assets.map((asset) => asset.id),
      ),
      10_000,
    )
      .filter((variant) => variant.kind === ENHANCED_VARIANT)
      .map((variant) => variant.assetId),
  );

  for (const asset of assets) {
    const hasCopy = withCopy.has(asset.id);
    const accepted = asset.enhanceAcceptedAt != null && hasCopy;
    out.set(asset.id, {
      state: asset.enhanceState,
      hasCopy,
      accepted,
      ...(asset.enhanceNote ? { note: asset.enhanceNote } : {}),
      ...(accepted ? { badge: ENHANCED_BADGE } : {}),
    });
  }
  return out;
}

/**
 * Which variant this photograph should be served from.
 *
 * One function, used by the EDL builder and by anything else that resolves a
 * picture, so "accepted" means the same thing in the preview, in the render and
 * on the screen. Falling back to the plain variant when the enhanced copy is
 * missing is deliberate: a family should never lose a photograph to a
 * half-finished enhancement.
 */
export function servingVariant(
  asset: Pick<MediaAsset, 'id' | 'enhanceAcceptedAt'>,
  variants: readonly Pick<AssetVariant, 'kind'>[],
): 'render2400' | 'enhanced2400' {
  const hasEnhanced = variants.some((variant) => variant.kind === ENHANCED_VARIANT);
  return asset.enhanceAcceptedAt != null && hasEnhanced ? ENHANCED_VARIANT : 'render2400';
}

/** Start the work. A button, never automatic — see the file comment. */
export function requestEnhancement(
  db: Db,
  memorialId: string,
  assetId: string,
): JobRow | undefined {
  const asset = getById(db, mediaAssets, assetId);
  if (!asset || asset.memorialId !== memorialId || asset.deletedAt != null) return undefined;
  if (!asset.mime.startsWith('image/')) return undefined;

  updateById(db, mediaAssets, assetId, { enhanceState: 'queued', enhanceNote: null });
  return enqueue(db, { type: 'enhance-asset', memorialId, assetId }, { memorialId, priority: 2 });
}

/** "Use the improved version." Reversible, and it says so on the screen. */
export function acceptEnhancement(
  db: Db,
  memorialId: string,
  assetId: string,
  now: number = Date.now(),
): MediaAsset | undefined {
  const asset = getById(db, mediaAssets, assetId);
  if (!asset || asset.memorialId !== memorialId) return undefined;
  const hasCopy = listWhere(db, assetVariants, eq(assetVariants.assetId, assetId), 10).some(
    (variant) => variant.kind === ENHANCED_VARIANT,
  );
  if (!hasCopy) return undefined;
  return updateById(db, mediaAssets, assetId, {
    enhanceAcceptedAt: now,
    enhanceState: 'accepted',
  });
}

/**
 * "Keep the original."
 *
 * The enhanced variant is *not* deleted: changing your mind twice is ordinary,
 * and re-running the work to undo an undo would be unkind. It simply stops
 * being the one anything serves.
 */
export function revertEnhancement(
  db: Db,
  memorialId: string,
  assetId: string,
): MediaAsset | undefined {
  const asset = getById(db, mediaAssets, assetId);
  if (!asset || asset.memorialId !== memorialId) return undefined;
  return updateById(db, mediaAssets, assetId, {
    enhanceAcceptedAt: null,
    enhanceState: asset.enhanceState === 'failed' ? 'failed' : 'ready',
  });
}
