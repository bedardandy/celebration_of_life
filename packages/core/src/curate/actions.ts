/**
 * The four things an organiser can do to a photo, and their words.
 *
 * Everything here autosaves and everything here is reversible, because the
 * curation grid is used with a thumb, at night, by someone who is exhausted.
 * There is no Save button to miss and no confirmation dialog to read: an
 * approve is a tap, a hide is a tap, and both can be tapped again.
 */
import {
  and,
  eq,
  getById,
  insertOne,
  isNull,
  listWhere,
  mediaAssets,
  memoryNotes,
  updateById,
  type Db,
  type MediaAsset,
} from '@col/db';

export type CurationAction =
  'approve' | 'unapprove' | 'hide' | 'unhide' | 'flag-who' | 'unflag-who';

export const CURATION_ACTION_MESSAGE: Record<CurationAction, string> = {
  approve: 'Kept.',
  unapprove: 'Set aside for now.',
  hide: 'Hidden. It is still here if you want it back.',
  unhide: 'Back in the grid.',
  'flag-who': 'Marked "who is this?" — you can ask the family.',
  'unflag-who': 'Question removed.',
};

function ownedAsset(db: Db, memorialId: string, assetId: string): MediaAsset | undefined {
  const asset = getById(db, mediaAssets, assetId);
  if (!asset || asset.memorialId !== memorialId || asset.deletedAt != null) return undefined;
  return asset;
}

export type CurationOutcome = {
  asset: MediaAsset;
  message: string;
};

export function applyCurationAction(
  db: Db,
  memorialId: string,
  assetId: string,
  action: CurationAction,
): CurationOutcome | undefined {
  const asset = ownedAsset(db, memorialId, assetId);
  if (!asset) return undefined;

  const patch: Partial<MediaAsset> = {};
  switch (action) {
    case 'approve':
      patch.curationState = 'approved';
      break;
    case 'unapprove':
      patch.curationState = 'pending';
      break;
    case 'hide':
      patch.curationState = 'hidden';
      break;
    case 'unhide':
      patch.curationState = 'pending';
      break;
    case 'flag-who':
      patch.needsIdentification = true;
      break;
    case 'unflag-who':
      patch.needsIdentification = false;
      break;
  }

  const updated = updateById(db, mediaAssets, assetId, patch) ?? asset;
  return { asset: updated, message: CURATION_ACTION_MESSAGE[action] };
}

/** Tap to approve, tap again to undo. One control, no modes. */
export function toggleApproval(
  db: Db,
  memorialId: string,
  assetId: string,
): CurationOutcome | undefined {
  const asset = ownedAsset(db, memorialId, assetId);
  if (!asset) return undefined;
  return applyCurationAction(
    db,
    memorialId,
    assetId,
    asset.curationState === 'approved' ? 'unapprove' : 'approve',
  );
}

export function toggleHidden(
  db: Db,
  memorialId: string,
  assetId: string,
): CurationOutcome | undefined {
  const asset = ownedAsset(db, memorialId, assetId);
  if (!asset) return undefined;
  const hidden = asset.curationState === 'hidden' || asset.curationState === 'rejected';
  return applyCurationAction(db, memorialId, assetId, hidden ? 'unhide' : 'hide');
}

export function toggleNeedsIdentification(
  db: Db,
  memorialId: string,
  assetId: string,
): CurationOutcome | undefined {
  const asset = ownedAsset(db, memorialId, assetId);
  if (!asset) return undefined;
  return applyCurationAction(
    db,
    memorialId,
    assetId,
    asset.needsIdentification ? 'unflag-who' : 'flag-who',
  );
}

/**
 * A note about a photo, from whoever is looking at it. The same table holds a
 * contributor's "this was the day we moved in" and an organiser's "ask Tom who
 * the man on the left is", because both end up in the same story.
 */
export function addPhotoNote(
  db: Db,
  input: {
    memorialId: string;
    assetId?: string | null;
    participantId?: string | null;
    authorName?: string | null;
    promptSlug?: string | null;
    text: string;
    /** Organiser notes are approved on sight; contributions wait to be read. */
    approved?: boolean;
  },
): ReturnType<typeof insertOne<typeof memoryNotes>> | undefined {
  const text = input.text.trim();
  if (!text) return undefined;
  if (input.assetId && !ownedAsset(db, input.memorialId, input.assetId)) return undefined;

  return insertOne(db, memoryNotes, {
    memorialId: input.memorialId,
    assetId: input.assetId ?? null,
    participantId: input.participantId ?? null,
    authorName: input.authorName ?? null,
    promptSlug: input.promptSlug ?? null,
    text: text.slice(0, 4_000),
    approved: input.approved ?? false,
  });
}

/** assetId → how many notes are attached, for the little count on a card. */
export function noteCountsByAsset(db: Db, memorialId: string): Map<string, number> {
  const notes = listWhere(
    db,
    memoryNotes,
    and(eq(memoryNotes.memorialId, memorialId), isNull(memoryNotes.deletedAt)),
    5_000,
  );
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (!note.assetId) continue;
    counts.set(note.assetId, (counts.get(note.assetId) ?? 0) + 1);
  }
  return counts;
}

/** The memory prompt every contributor is asked once, at the end. */
export const UNFORGETTABLE_PROMPT_SLUG = 'unforgettable-moment';

export function unforgettableMomentPrompt(decedentName: string): string {
  return `What's one moment with ${decedentName} you'll never forget?`;
}
