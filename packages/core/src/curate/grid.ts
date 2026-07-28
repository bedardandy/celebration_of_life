/**
 * What the curation grid shows, decided away from the screen.
 *
 * Curation is the longest sitting-down job in this product, and the one most
 * likely to be done at eleven at night. So the grid is built from three rules,
 * all of them here where they can be tested:
 *
 *  1. Photos are grouped by decade, because "when was this?" is how families
 *     talk about photographs, and because era gaps are what the slideshow will
 *     later feel as holes.
 *  2. Near-duplicates collapse to one card. Four frames of one moment are one
 *     decision, not four.
 *  3. Nothing is ever hidden by the software. A blurry photo gets a badge; a
 *     photo we could not open gets an explanation. The family decides.
 */
import { eraStartYear, isBlurry, BLURRY_BADGE } from '@col/media';
import type { MediaAsset } from '@col/db';

export const UNKNOWN_ERA = 'unknown';
export const UNKNOWN_ERA_LABEL = 'When was this?';

export type CurationAsset = Pick<
  MediaAsset,
  | 'id'
  | 'originalFilename'
  | 'mime'
  | 'capturedAt'
  | 'eraGuess'
  | 'phash'
  | 'qualityScore'
  | 'blurScore'
  | 'dupeGroupId'
  | 'dupeRepresentative'
  | 'needsIdentification'
  | 'curationState'
  | 'ingestState'
  | 'ingestError'
  | 'caption'
  | 'uploadedByParticipantId'
  | 'createdAt'
>;

export type CurationCard = {
  /** The photo shown on the card. */
  asset: CurationAsset;
  /** Other frames of the same moment, sharpest first. Empty for most photos. */
  alternates: CurationAsset[];
  approved: boolean;
  hidden: boolean;
  blurry: boolean;
  /** Badge copy, or undefined when there is nothing to say. */
  badge?: string;
  needsIdentification: boolean;
  /** Set when ingest could not read the file. */
  problem?: string;
  contributorName?: string;
  noteCount: number;
};

export type EraGroup = {
  era: string;
  label: string;
  /** Sort key: the decade's first year, or +Infinity for the unknown group. */
  startYear: number;
  cards: CurationCard[];
};

export type CurationCounts = {
  photos: number;
  approved: number;
  hidden: number;
  blurry: number;
  duplicatesCollapsed: number;
  needsIdentification: number;
  contributors: number;
  problems: number;
  videos: number;
};

export type CurationView = {
  groups: EraGroup[];
  counts: CurationCounts;
  /** "42 photos from 5 people, 28 approved." */
  summary: string;
};

export function eraLabel(era: string): string {
  return era === UNKNOWN_ERA ? UNKNOWN_ERA_LABEL : era;
}

function eraOf(asset: CurationAsset): string {
  if (asset.eraGuess) return asset.eraGuess;
  if (asset.capturedAt) {
    const year = new Date(asset.capturedAt).getUTCFullYear();
    return `${Math.floor(year / 10) * 10}s`;
  }
  return UNKNOWN_ERA;
}

function isVideo(asset: CurationAsset): boolean {
  return asset.mime.toLowerCase().startsWith('video/');
}

export type BuildViewInput = {
  assets: readonly CurationAsset[];
  /** participantId → display name, for attribution under a card. */
  contributorNames?: Map<string, string>;
  /** assetId → number of memory notes attached. */
  noteCounts?: Map<string, number>;
};

/**
 * Sort inside a group: sharpest first among equals, but chronological when we
 * know the times. Deterministic, so the grid does not reshuffle under someone's
 * hand between two taps.
 */
function compareCards(a: CurationCard, b: CurationCard): number {
  const at = a.asset.capturedAt;
  const bt = b.asset.capturedAt;
  if (at != null && bt != null && at !== bt) return at - bt;
  if (at != null && bt == null) return -1;
  if (at == null && bt != null) return 1;
  return a.asset.createdAt - b.asset.createdAt || (a.asset.id < b.asset.id ? -1 : 1);
}

export function buildCurationView(input: BuildViewInput): CurationView {
  const { assets } = input;
  const contributorNames = input.contributorNames ?? new Map<string, string>();
  const noteCounts = input.noteCounts ?? new Map<string, number>();

  // Collapse duplicate groups first, so era grouping sees one card per moment.
  const byGroup = new Map<string, CurationAsset[]>();
  const singles: CurationAsset[] = [];
  for (const asset of assets) {
    if (asset.dupeGroupId) {
      const bucket = byGroup.get(asset.dupeGroupId);
      if (bucket) bucket.push(asset);
      else byGroup.set(asset.dupeGroupId, [asset]);
    } else {
      singles.push(asset);
    }
  }

  const cards: CurationCard[] = [];
  let duplicatesCollapsed = 0;

  const toCard = (asset: CurationAsset, alternates: CurationAsset[]): CurationCard => {
    const blurry = isBlurry(asset.blurScore);
    const problem =
      asset.ingestState === 'failed'
        ? (asset.ingestError ?? 'We could not open this one. Nothing is lost — try sending it again.')
        : undefined;
    const contributor = asset.uploadedByParticipantId
      ? contributorNames.get(asset.uploadedByParticipantId)
      : undefined;
    return {
      asset,
      alternates,
      approved: asset.curationState === 'approved',
      hidden: asset.curationState === 'hidden' || asset.curationState === 'rejected',
      blurry,
      ...(blurry && !problem ? { badge: BLURRY_BADGE } : {}),
      needsIdentification: asset.needsIdentification,
      ...(problem ? { problem } : {}),
      ...(contributor ? { contributorName: contributor } : {}),
      noteCount: noteCounts.get(asset.id) ?? 0,
    };
  };

  for (const asset of singles) cards.push(toCard(asset, []));

  for (const members of byGroup.values()) {
    if (members.length === 1) {
      cards.push(toCard(members[0] as CurationAsset, []));
      continue;
    }
    const ordered = [...members].sort(
      (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0) || (a.id < b.id ? -1 : 1),
    );
    const chosen = ordered.find((m) => m.dupeRepresentative) ?? (ordered[0] as CurationAsset);
    const alternates = ordered.filter((m) => m.id !== chosen.id);
    duplicatesCollapsed += alternates.length;
    cards.push(toCard(chosen, alternates));
  }

  const groups = new Map<string, EraGroup>();
  for (const card of cards) {
    const era = eraOf(card.asset);
    const group = groups.get(era);
    if (group) group.cards.push(card);
    else {
      groups.set(era, {
        era,
        label: eraLabel(era),
        startYear: era === UNKNOWN_ERA ? Number.POSITIVE_INFINITY : (eraStartYear(era) ?? 0),
        cards: [card],
      });
    }
  }

  const orderedGroups = [...groups.values()].sort((a, b) => a.startYear - b.startYear);
  for (const group of orderedGroups) group.cards.sort(compareCards);

  const contributors = new Set(
    assets.map((a) => a.uploadedByParticipantId).filter((id): id is string => Boolean(id)),
  );

  const counts: CurationCounts = {
    photos: assets.length,
    approved: assets.filter((a) => a.curationState === 'approved').length,
    hidden: assets.filter((a) => a.curationState === 'hidden' || a.curationState === 'rejected')
      .length,
    blurry: assets.filter((a) => isBlurry(a.blurScore)).length,
    duplicatesCollapsed,
    needsIdentification: assets.filter((a) => a.needsIdentification).length,
    contributors: contributors.size,
    problems: assets.filter((a) => a.ingestState === 'failed').length,
    videos: assets.filter(isVideo).length,
  };

  return { groups: orderedGroups, counts, summary: summarise(counts) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence, in the order a person would say it. */
export function summarise(counts: CurationCounts): string {
  if (counts.photos === 0) return 'No photos yet. They will appear here as they arrive.';
  const from =
    counts.contributors > 0 ? ` from ${plural(counts.contributors, 'person', 'people')}` : '';
  return `${plural(counts.photos, 'photo')}${from}, ${counts.approved} approved.`;
}

/** Copy for the collapsed duplicate card. */
export function duplicateCardLine(alternateCount: number): string {
  const total = alternateCount + 1;
  return `${total} similar photos — we picked the sharpest.`;
}
