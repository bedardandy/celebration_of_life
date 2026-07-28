/**
 * Which photographs a run of analysis would actually cover.
 *
 * A plain server module rather than part of `actions.ts`, because a
 * `'use server'` file may only export async functions — and the story page
 * needs this synchronously to decide whether to offer the button at all.
 */
import { and, eq, isNull, listWhere, mediaAssets, type Db } from '@col/db';

/** Still here, not thrown away by the family, and not yet described. */
export function analyzableAssetIds(db: Db, memorialId: string): string[] {
  return listWhere(
    db,
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    500,
  )
    .filter(
      (asset) =>
        asset.mime.startsWith('image/') &&
        asset.curationState !== 'rejected' &&
        asset.analysis == null,
    )
    .map((asset) => asset.id);
}
