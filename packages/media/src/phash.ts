/**
 * Near-duplicate detection.
 *
 * Families do not upload one photo of a moment, they upload four: the same
 * three cousins on the same porch, one blinking. Showing all four in the
 * curation grid makes an already long job longer, and putting all four in the
 * slideshow makes the slideshow feel like a mistake. So we group them and show
 * one card.
 *
 * The hash is a 64-bit DCT perceptual hash rendered as a 64-character string of
 * '0' and '1' (sharp-phash's format, kept verbatim so the value in the database
 * is directly comparable with the library's own output).
 */
import phashOf from 'sharp-phash';
import hammingDistance from 'sharp-phash/distance';

export const PHASH_BITS = 64;

/**
 * Bits that may differ before two photos stop being "the same moment".
 *
 * Calibrated against the fixture set (see phash.test.ts): two shots of one
 * scene — reframed slightly, one a third of a stop brighter — sit at a distance
 * of about 3, while genuinely different photographs sit at 19 and above. Ten is
 * the middle of that gap, which is where a threshold should live: raising it
 * would start merging different photos, and merging two real memories into one
 * card is the expensive mistake, not showing a duplicate.
 */
export const DUPE_HAMMING_THRESHOLD = 10;

export async function perceptualHash(input: Buffer): Promise<string> {
  return phashOf(input);
}

export function isValidPhash(value: unknown): value is string {
  return typeof value === 'string' && value.length === PHASH_BITS && /^[01]+$/.test(value);
}

/** Bits that differ. Returns undefined when either hash is unusable. */
export function phashDistance(a: string, b: string): number | undefined {
  if (!isValidPhash(a) || !isValidPhash(b)) return undefined;
  return hammingDistance(a, b);
}

export function looksLikeSameMoment(
  a: string,
  b: string,
  threshold: number = DUPE_HAMMING_THRESHOLD,
): boolean {
  const d = phashDistance(a, b);
  return d !== undefined && d <= threshold;
}

export type HashedItem = {
  id: string;
  phash: string | null | undefined;
  /** 0..1. Decides which member of a group is shown by default. */
  qualityScore?: number | null;
};

export type DupeGroup = {
  /** Stable id: the smallest member id, so grouping is deterministic. */
  groupId: string;
  memberIds: string[];
  /** The sharpest member — the one the grid shows. */
  representativeId: string;
};

/**
 * Single-link clustering over the hamming distance.
 *
 * Single-link (rather than "everything within N of a centre") matches how
 * people actually shoot: a burst drifts, and the first and last frame can be
 * further apart than the threshold while every neighbouring pair is close. The
 * family sees one card either way.
 */
export function groupNearDuplicates(
  items: readonly HashedItem[],
  threshold: number = DUPE_HAMMING_THRESHOLD,
): DupeGroup[] {
  const usable = items.filter((i) => isValidPhash(i.phash));
  const parent = new Map<string, string>();
  for (const item of usable) parent.set(item.id, item.id);

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Path compression keeps repeated lookups cheap on large uploads.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the smaller id as the root so group ids are stable across runs.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i] as HashedItem;
      const b = usable[j] as HashedItem;
      if (looksLikeSameMoment(a.phash as string, b.phash as string, threshold)) union(a.id, b.id);
    }
  }

  const byRoot = new Map<string, HashedItem[]>();
  for (const item of usable) {
    const root = find(item.id);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(item);
    else byRoot.set(root, [item]);
  }

  const groups: DupeGroup[] = [];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue; // a group of one is just a photo
    const sorted = [...members].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    groups.push({
      groupId: root,
      memberIds: sorted.map((m) => m.id),
      representativeId: pickRepresentative(sorted),
    });
  }
  return groups.sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
}

/** Sharpest wins; ties break on id so the choice never wanders between runs. */
export function pickRepresentative(members: readonly HashedItem[]): string {
  let best = members[0];
  if (!best) throw new Error('pickRepresentative: no members');
  for (const member of members.slice(1)) {
    const a = member.qualityScore ?? 0;
    const b = best.qualityScore ?? 0;
    if (a > b || (a === b && member.id < best.id)) best = member;
  }
  return best.id;
}
