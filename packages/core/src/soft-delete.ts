/**
 * Soft delete, with a way back.
 *
 * Nothing a family removes should be gone the instant they tap it. Grief brain
 * makes mis-taps ordinary, and the things in here are irreplaceable — a photo
 * nobody else has, a memory only one person remembers. So "remove" writes a
 * tombstone, the interface offers Undo for a few seconds, and the real purge is
 * a separate, deliberate act later.
 *
 * The registry exists so one server action can undo any of these without the
 * browser ever naming a table.
 */
import {
  mediaAssets,
  memorials,
  memoryNotes,
  restoreById,
  slideshowProjects,
  softDeleteById,
  type Db,
} from '@col/db';

export { UNDO_WINDOW_SEC } from './ui';

export const SOFT_DELETABLE = {
  memorial: memorials,
  photo: mediaAssets,
  memory: memoryNotes,
  slideshow: slideshowProjects,
} as const;

export type SoftDeletableKind = keyof typeof SOFT_DELETABLE;

export function isSoftDeletableKind(value: unknown): value is SoftDeletableKind {
  return typeof value === 'string' && Object.hasOwn(SOFT_DELETABLE, value);
}

export type SoftDeleteResult = {
  kind: SoftDeletableKind;
  id: string;
  deletedAt: number;
  /** Plain sentence for the Undo toast. Says what happened, offers the way back. */
  message: string;
};

const REMOVED_MESSAGE: Record<SoftDeletableKind, string> = {
  memorial: 'Removed. Nothing is deleted yet.',
  photo: 'Photo removed.',
  memory: 'Memory removed.',
  slideshow: 'Slideshow removed.',
};

export function softDelete(
  db: Db,
  kind: SoftDeletableKind,
  id: string,
  at: number = Date.now(),
): SoftDeleteResult | undefined {
  const row = softDeleteById(db, SOFT_DELETABLE[kind], id, at);
  if (!row) return undefined;
  return { kind, id, deletedAt: at, message: REMOVED_MESSAGE[kind] };
}

export function restore(db: Db, kind: SoftDeletableKind, id: string): boolean {
  return restoreById(db, SOFT_DELETABLE[kind], id) !== undefined;
}
