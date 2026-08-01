/**
 * What the curation screen knows about faces, and the words it uses.
 *
 * The copy lives here beside the logic that decides when to show it, because
 * the two cannot drift: this is the most easily-misread feature in the product,
 * and the sentence "this happens entirely on this computer and is deleted with
 * the memorial" has to appear at exactly the moment somebody is deciding.
 *
 * The state machine is small and one of its states is *nothing at all*. When no
 * engine is installed there is no card, no teaser and no explanation of a thing
 * the family cannot have.
 */
import {
  and,
  enqueue,
  eq,
  getById,
  inArray,
  jobs,
  listWhere,
  mediaAssets,
  memorials,
  updateById,
  type Db,
  type JobRow,
  type MediaAsset,
  type Memorial,
} from '@col/db';
import { findCoverageGaps, primaryGap, type CoverageGap } from '../curate/coverage';
import { UNKNOWN_ERA } from '../curate/grid';
import {
  facePendingAssets,
  listFaceClusters,
  namedFaces,
  type ClusterSummary,
  type NamedFace,
} from './store';

/* -------------------------------------------------------------------------- */
/* copy                                                                        */
/* -------------------------------------------------------------------------- */

export const FACE_GROUPING_COPY = {
  title: 'Find the same faces across your photos',
  /** The consent sentence. Both halves of it are load-bearing. */
  body:
    'This happens entirely on this computer and is deleted with the memorial. ' +
    'Nothing is sent anywhere, and nothing is decided without you.',
  start: 'Find the same faces',
  again: 'Look through the new photos too',
  working: "We're looking through the photos on this computer. You do not need to wait here.",
  clusterPrompt: 'These look like the same person',
  nameLabel: 'Who is this?',
  namePlaceholder: 'Ruth',
  nameButton: 'That is who it is',
  dismiss: 'Not the same person',
  nothing: 'We did not find faces that repeat. That happens with small sets, and nothing is wrong.',
  everyone: 'Everyone',
} as const;

/** The chip: "Ruth · 34 photos". */
export function faceChipLabel(face: NamedFace): string {
  return `${face.name} · ${face.photoCount} ${face.photoCount === 1 ? 'photo' : 'photos'}`;
}

/* -------------------------------------------------------------------------- */
/* state                                                                       */
/* -------------------------------------------------------------------------- */

export type FacesView =
  /** No engine on this machine and nothing recorded: the feature does not exist. */
  | { state: 'unavailable' }
  /** Offered, never started. */
  | { state: 'offer'; pendingPhotos: number }
  /** A job is queued or running. */
  | { state: 'working' }
  | {
      state: 'ready';
      /** Groups nobody has named yet, biggest first. */
      suggestions: ClusterSummary[];
      named: NamedFace[];
      /** Photographs added since the last pass. */
      pendingPhotos: number;
    };

export type FacesViewInput = {
  /** From `faceEngineConfigured()` — cheap, and false in most deployments. */
  engineConfigured: boolean;
  /** How many suggestions to put on screen at once. More is a to-do list. */
  maxSuggestions?: number;
};

export function facesView(db: Db, memorial: Memorial, input: FacesViewInput): FacesView {
  const clusters = listFaceClusters(db, memorial.id);
  const named = namedFaces(db, memorial.id);
  const hasWork = clusters.length > 0 || named.length > 0;

  if (!input.engineConfigured && !hasWork) return { state: 'unavailable' };

  if (faceJobPending(db, memorial.id)) return { state: 'working' };

  const pendingPhotos = input.engineConfigured ? facePendingAssets(db, memorial.id).length : 0;

  if (!memorial.faceGroupingStartedAt && !hasWork) {
    return { state: 'offer', pendingPhotos };
  }

  const suggestions = clusters
    .filter((cluster) => !cluster.personId && cluster.photoCount > 1)
    .slice(0, input.maxSuggestions ?? 3);

  return { state: 'ready', suggestions, named, pendingPhotos };
}

/** A detect-faces job waiting or under way for this memorial. */
export function faceJobPending(db: Db, memorialId: string): boolean {
  return (
    db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.memorialId, memorialId),
          eq(jobs.type, 'detect-faces'),
          inArray(jobs.status, ['queued', 'running']),
        ),
      )
      .limit(1)
      .all().length > 0
  );
}

/**
 * The explicit action. Face grouping never starts on upload, never on a
 * schedule, and never as a side effect of anything else: somebody presses this.
 */
export function startFaceGrouping(
  db: Db,
  memorialId: string,
  options: { redo?: boolean; now?: number } = {},
): JobRow {
  updateById(db, memorials, memorialId, { faceGroupingStartedAt: options.now ?? Date.now() });
  return enqueue(
    db,
    {
      type: 'detect-faces',
      memorialId,
      redo: options.redo ?? false,
    },
    { memorialId, priority: 1 },
  );
}

/* -------------------------------------------------------------------------- */
/* coverage, for one face                                                      */
/* -------------------------------------------------------------------------- */

export type PersonCoverage = {
  person: NamedFace;
  gap?: CoverageGap;
  countsByEra: Map<string, number>;
};

/**
 * "No photos of Ruth from their thirties yet."
 *
 * Ages are only used when the named person is the person who died — they are
 * the only one whose birth year we know — and otherwise the nudge talks in
 * decades, which is still specific enough to hand to an aunt.
 */
export function personCoverage(db: Db, memorial: Memorial, face: NamedFace): PersonCoverage {
  const assets = listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id), 5_000).filter(
    (asset) => face.assetIds.includes(asset.id) && asset.deletedAt == null,
  );

  const countsByEra = new Map<string, number>();
  for (const asset of assets) {
    const era = eraOf(asset);
    countsByEra.set(era, (countsByEra.get(era) ?? 0) + 1);
  }

  const gaps = findCoverageGaps({
    ...(face.isDecedent ? { birthYear: memorial.birthYear, deathYear: memorial.deathYear } : {}),
    countsByEra,
    subject: face.name,
  });

  const gap = primaryGap(gaps);
  return { person: face, countsByEra, ...(gap ? { gap } : {}) };
}

function eraOf(asset: MediaAsset): string {
  if (asset.eraGuess) return asset.eraGuess;
  if (asset.capturedAt) {
    const year = new Date(asset.capturedAt).getUTCFullYear();
    return `${Math.floor(year / 10) * 10}s`;
  }
  return UNKNOWN_ERA;
}

/** Used by the curate page to check a person filter actually belongs here. */
export function findNamedFace(db: Db, memorialId: string, personId: string): NamedFace | undefined {
  const memorial = getById(db, memorials, memorialId);
  if (!memorial) return undefined;
  return namedFaces(db, memorialId).find((face) => face.personId === personId);
}
