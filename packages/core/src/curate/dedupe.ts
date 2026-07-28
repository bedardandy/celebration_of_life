/**
 * Keeping duplicate groups up to date as photos arrive.
 *
 * Grouping cannot be done once at upload time: the fourth frame of a burst
 * often arrives from a different cousin an hour later, and the group only makes
 * sense when all of it is there. So after every ingest we regroup the memorial,
 * which is cheap (a 64-bit hash comparison over a few hundred rows) and means
 * the grid is never half-grouped.
 *
 * The one thing regrouping must not do is undo a decision the family made. If
 * an organiser chose which frame of a burst to show, that choice survives every
 * later regrouping, for as long as that photo is still in the group.
 */
import {
  and,
  eq,
  isNull,
  listWhere,
  mediaAssets,
  updateById,
  type Db,
  type MediaAsset,
} from '@col/db';
import { groupNearDuplicates, pickRepresentative, type HashedItem } from '@col/media';

export type RegroupResult = {
  groupCount: number;
  groupedAssetIds: string[];
};

function candidates(db: Db, memorialId: string): MediaAsset[] {
  return listWhere(
    db,
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    5_000,
  ).filter((a) => a.ingestState === 'ready' && typeof a.phash === 'string');
}

/** Recompute every duplicate group in one memorial, preserving family choices. */
export function regroupDuplicates(db: Db, memorialId: string): RegroupResult {
  const assets = candidates(db, memorialId);
  const items: HashedItem[] = assets.map((a) => ({
    id: a.id,
    phash: a.phash,
    qualityScore: a.qualityScore,
  }));
  const groups = groupNearDuplicates(items);

  const byId = new Map(assets.map((a) => [a.id, a]));
  const grouped = new Set<string>();

  for (const group of groups) {
    const members = group.memberIds
      .map((id) => byId.get(id))
      .filter((a): a is MediaAsset => a !== undefined);

    // A representative the family picked wins over the sharpest one we found.
    const chosen = members.find((m) => m.dupeRepresentative);
    const representativeId =
      chosen?.id ??
      pickRepresentative(
        members.map((m) => ({ id: m.id, phash: m.phash, qualityScore: m.qualityScore })),
      );

    for (const member of members) {
      grouped.add(member.id);
      const wantsRepresentative = member.id === representativeId;
      if (
        member.dupeGroupId === group.groupId &&
        member.dupeRepresentative === wantsRepresentative
      ) {
        continue;
      }
      updateById(db, mediaAssets, member.id, {
        dupeGroupId: group.groupId,
        dupeRepresentative: wantsRepresentative,
      });
    }
  }

  // Anything that used to be in a group and no longer is goes back to standing
  // on its own — otherwise a deleted twin leaves a lonely "1 similar photo".
  for (const asset of assets) {
    if (grouped.has(asset.id)) continue;
    if (asset.dupeGroupId == null && !asset.dupeRepresentative) continue;
    updateById(db, mediaAssets, asset.id, { dupeGroupId: null, dupeRepresentative: false });
  }

  return { groupCount: groups.length, groupedAssetIds: [...grouped] };
}

/**
 * "Show this one instead." The family looked at four near-identical frames and
 * picked the one where the dog is looking at the camera; no score beats that.
 */
export function setDupeRepresentative(db: Db, memorialId: string, assetId: string): boolean {
  const asset = listWhere(db, mediaAssets, eq(mediaAssets.id, assetId), 1)[0];
  if (!asset || asset.memorialId !== memorialId || !asset.dupeGroupId) return false;

  const members = listWhere(
    db,
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), eq(mediaAssets.dupeGroupId, asset.dupeGroupId)),
  );
  for (const member of members) {
    const shouldBe = member.id === assetId;
    if (member.dupeRepresentative !== shouldBe) {
      updateById(db, mediaAssets, member.id, { dupeRepresentative: shouldBe });
    }
  }
  return true;
}
