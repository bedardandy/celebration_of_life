/**
 * Faces, in the database.
 *
 * The whole feature exists to answer one question a family actually asks —
 * "where are the photographs of Ruth?" — and it is built so that answering it
 * never costs anybody their privacy:
 *
 *  - detection runs on this machine, from an engine an operator installed;
 *  - what is stored is a vector and a rectangle, both meaningless elsewhere;
 *  - everything hangs off `memorialId`, so removing a memorial removes the
 *    faces with it, by foreign key, with no separate cleanup to forget;
 *  - a group is a *suggestion* until a person names it, and "not the same
 *    person" is always available.
 *
 * Grouping is recomputed from scratch whenever it runs, which means cluster
 * labels are disposable. Names are not: they live on `personId`, they survive
 * regrouping, and a new photograph of a named person inherits the name from the
 * group it lands in.
 */
import {
  and,
  eq,
  faceDetections,
  getById,
  insertOne,
  isNull,
  listWhere,
  mediaAssets,
  memorials,
  people,
  updateById,
  type Db,
  type FaceDetection,
  type MediaAsset,
  type Person,
} from '@col/db';
import { clusterFaces, type DetectedFace } from '@col/media';
import type { FaceBox } from '@col/schemas';

/* -------------------------------------------------------------------------- */
/* writing what an engine found                                                */
/* -------------------------------------------------------------------------- */

export type RecordFacesInput = {
  memorialId: string;
  assetId: string;
  engine: string;
  faces: readonly DetectedFace[];
};

/**
 * Replace what we know about one photograph's faces.
 *
 * Wholesale rather than merged, so re-running after a model change leaves no
 * half-old set behind. Any name already attached to a face in this photograph
 * is carried over by position, because a family should not have to say "this is
 * Ruth" twice because we changed detector.
 */
export function recordFaceDetections(db: Db, input: RecordFacesInput): FaceDetection[] {
  const existing = listWhere(db, faceDetections, eq(faceDetections.assetId, input.assetId), 200);
  const inherited = existing.find((row) => row.personId)?.personId ?? null;

  db.delete(faceDetections).where(eq(faceDetections.assetId, input.assetId)).run();

  return input.faces.map((face) =>
    insertOne(db, faceDetections, {
      memorialId: input.memorialId,
      assetId: input.assetId,
      box: face.box,
      embedding: face.embedding,
      quality: face.quality,
      engine: input.engine,
      // Only when there was exactly one face before and one now: anything else
      // and "which face was Ruth" is a guess, and guessing puts a stranger's
      // name on somebody.
      personId: existing.length === 1 && input.faces.length === 1 ? inherited : null,
    }),
  );
}

/** Photographs worth looking at: ready, still here, and actually a photograph. */
export function facePendingAssets(db: Db, memorialId: string, redo = false): MediaAsset[] {
  const assets = listWhere(
    db,
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    2_000,
  ).filter(
    (asset) =>
      asset.mime.startsWith('image/') &&
      asset.ingestState === 'ready' &&
      asset.curationState !== 'rejected',
  );
  if (redo) return assets;

  const seen = new Set(
    listWhere(db, faceDetections, eq(faceDetections.memorialId, memorialId), 20_000).map(
      (row) => row.assetId,
    ),
  );
  // A photograph with no faces in it records nothing, so "already looked at" is
  // tracked by the asset's own `faceScannedAt`-shaped signal: its rows, or the
  // absence of them after a completed pass. We accept re-scanning empty rooms;
  // it is cheap and it is correct when new detections arrive from a new engine.
  return assets.filter((asset) => !seen.has(asset.id));
}

/* -------------------------------------------------------------------------- */
/* grouping                                                                    */
/* -------------------------------------------------------------------------- */

export type FaceGroupingResult = {
  clusters: number;
  faces: number;
  /** Groups that inherited a name from a face already named. */
  named: number;
};

/**
 * Recompute the groups for one memorial.
 *
 * Dismissed faces are left out of the maths entirely — a family who said "not
 * the same person" should not be asked again by a slightly different grouping —
 * but the rows stay, because the photographs are still theirs.
 */
export function regroupFaces(
  db: Db,
  memorialId: string,
  options: { threshold?: number } = {},
): FaceGroupingResult {
  const rows = listWhere(db, faceDetections, eq(faceDetections.memorialId, memorialId), 20_000);
  const live = rows.filter((row) => row.dismissedAt == null);

  const { clusters } = clusterFaces(
    live.map((row) => ({ id: row.id, embedding: row.embedding, quality: row.quality })),
    { ...(options.threshold !== undefined ? { threshold: options.threshold } : {}) },
  );

  const byId = new Map(live.map((row) => [row.id, row]));
  let named = 0;

  for (const cluster of clusters) {
    const members = cluster.memberIds
      .map((id) => byId.get(id))
      .filter((row): row is FaceDetection => row !== undefined);
    // A group inherits the name most of its members already carry.
    const personId = mostCommonPersonId(members);
    if (personId) named += 1;
    for (const member of members) {
      updateById(db, faceDetections, member.id, {
        clusterId: cluster.id,
        personId: personId ?? member.personId ?? null,
      });
    }
  }

  const grouped = new Set(clusters.flatMap((cluster) => cluster.memberIds));
  for (const row of live) {
    if (!grouped.has(row.id) && row.clusterId !== null) {
      updateById(db, faceDetections, row.id, { clusterId: null });
    }
  }

  return { clusters: clusters.length, faces: live.length, named };
}

function mostCommonPersonId(members: readonly FaceDetection[]): string | undefined {
  const counts = new Map<string, number>();
  for (const member of members) {
    if (!member.personId) continue;
    counts.set(member.personId, (counts.get(member.personId) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [personId, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) {
      best = personId;
      bestCount = count;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* naming                                                                      */
/* -------------------------------------------------------------------------- */

export type NamedCluster = { person: Person; faces: number };

/**
 * "This is Ruth."
 *
 * The name goes on a `people` row — the same table the story and the program
 * use, so a person named here is a person the rest of the product knows about —
 * and every face in the group points at it. If the name is the person who died,
 * the row is marked as such, which is what lets the coverage nudge talk about
 * their thirties rather than about a decade.
 */
export function nameFaceCluster(
  db: Db,
  input: { memorialId: string; clusterId: string; name: string },
): NamedCluster | undefined {
  const name = input.name.trim().slice(0, 120);
  if (!name) return undefined;

  const members = listWhere(
    db,
    faceDetections,
    and(
      eq(faceDetections.memorialId, input.memorialId),
      eq(faceDetections.clusterId, input.clusterId),
    ),
    5_000,
  ).filter((row) => row.dismissedAt == null);
  if (members.length === 0) return undefined;

  const person = findOrCreatePerson(db, input.memorialId, name);
  for (const member of members) {
    updateById(db, faceDetections, member.id, { personId: person.id, dismissedAt: null });
  }
  return { person, faces: members.length };
}

/** Reuse a person the family has already named rather than making a second one. */
export function findOrCreatePerson(db: Db, memorialId: string, name: string): Person {
  const existing = listWhere(db, people, eq(people.memorialId, memorialId), 500).find(
    (row) =>
      row.fullName.trim().toLowerCase() === name.trim().toLowerCase() ||
      row.knownAs?.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (existing) return existing;

  const memorial = getById(db, memorials, memorialId);
  const isDecedent = memorial ? namesTheDecedent(memorial, name) : false;
  return insertOne(db, people, { memorialId, fullName: name, isDecedent });
}

/** "Ruth", "Ruth Kelleher" and "Ruthie" all mean the person who died. */
export function namesTheDecedent(
  memorial: { decedentName: string; decedentKnownAs?: string | null },
  name: string,
): boolean {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return false;
  const full = memorial.decedentName.trim().toLowerCase();
  const known = memorial.decedentKnownAs?.trim().toLowerCase();
  const first = full.split(/\s+/)[0] ?? '';
  return wanted === full || (known !== undefined && wanted === known) || wanted === first;
}

/** "Not the same person" — the suggestion is put away, the photographs stay. */
export function dismissFaceCluster(
  db: Db,
  memorialId: string,
  clusterId: string,
  at: number = Date.now(),
): number {
  const members = listWhere(
    db,
    faceDetections,
    and(eq(faceDetections.memorialId, memorialId), eq(faceDetections.clusterId, clusterId)),
    5_000,
  );
  for (const member of members) {
    updateById(db, faceDetections, member.id, { dismissedAt: at, clusterId: null });
  }
  return members.length;
}

/** Undo, because everything in this product is undoable. */
export function unnameFaceCluster(db: Db, memorialId: string, personId: string): number {
  const members = listWhere(
    db,
    faceDetections,
    and(eq(faceDetections.memorialId, memorialId), eq(faceDetections.personId, personId)),
    5_000,
  );
  for (const member of members) updateById(db, faceDetections, member.id, { personId: null });
  return members.length;
}

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

export type FaceSample = { assetId: string; box: FaceBox };

export type ClusterSummary = {
  clusterId: string;
  /** Photographs this face appears in, which is what the family counts. */
  photoCount: number;
  faceCount: number;
  assetIds: string[];
  /** Up to four faces to show in the strip, best first. */
  samples: FaceSample[];
  personId?: string;
  personName?: string;
};

export function listFaceDetections(db: Db, memorialId: string): FaceDetection[] {
  return listWhere(db, faceDetections, eq(faceDetections.memorialId, memorialId), 20_000);
}

/**
 * Every group with a face in it, biggest first.
 *
 * Photographs the family has thrown away are left out: a suggestion built from
 * a rejected photograph is a suggestion about something they have already said
 * no to.
 */
export function listFaceClusters(db: Db, memorialId: string): ClusterSummary[] {
  const rows = listFaceDetections(db, memorialId).filter(
    (row) => row.dismissedAt == null && row.clusterId,
  );
  const livingAssets = new Set(
    listWhere(
      db,
      mediaAssets,
      and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
      5_000,
    )
      .filter((asset) => asset.curationState !== 'rejected')
      .map((asset) => asset.id),
  );

  const names = new Map(
    listWhere(db, people, eq(people.memorialId, memorialId), 500).map((p) => [p.id, p]),
  );
  const grouped = new Map<string, FaceDetection[]>();
  for (const row of rows) {
    if (!livingAssets.has(row.assetId)) continue;
    const bucket = grouped.get(row.clusterId as string);
    if (bucket) bucket.push(row);
    else grouped.set(row.clusterId as string, [row]);
  }

  const summaries: ClusterSummary[] = [];
  for (const [clusterId, members] of grouped) {
    const best = [...members].sort((a, b) => b.quality - a.quality || (a.id < b.id ? -1 : 1));
    const personId = best.find((row) => row.personId)?.personId ?? undefined;
    const person = personId ? names.get(personId) : undefined;
    const assetIds = [...new Set(members.map((row) => row.assetId))];
    summaries.push({
      clusterId,
      photoCount: assetIds.length,
      faceCount: members.length,
      assetIds,
      samples: best.slice(0, 4).map((row) => ({ assetId: row.assetId, box: row.box })),
      ...(personId ? { personId } : {}),
      ...(person ? { personName: person.knownAs ?? person.fullName } : {}),
    });
  }

  return summaries.sort(
    (a, b) => b.photoCount - a.photoCount || (a.clusterId < b.clusterId ? -1 : 1),
  );
}

export type NamedFace = {
  personId: string;
  name: string;
  photoCount: number;
  assetIds: string[];
  isDecedent: boolean;
};

/** The filter chips: one per person somebody has named. */
export function namedFaces(db: Db, memorialId: string): NamedFace[] {
  const rows = listFaceDetections(db, memorialId).filter(
    (row) => row.personId && row.dismissedAt == null,
  );
  const persons = new Map(
    listWhere(db, people, eq(people.memorialId, memorialId), 500).map((p) => [p.id, p]),
  );
  const living = new Set(
    listWhere(
      db,
      mediaAssets,
      and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
      5_000,
    ).map((asset) => asset.id),
  );

  const byPerson = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!living.has(row.assetId)) continue;
    const set = byPerson.get(row.personId as string) ?? new Set<string>();
    set.add(row.assetId);
    byPerson.set(row.personId as string, set);
  }

  const out: NamedFace[] = [];
  for (const [personId, assetIds] of byPerson) {
    const person = persons.get(personId);
    if (!person) continue;
    out.push({
      personId,
      name: person.knownAs ?? person.fullName,
      photoCount: assetIds.size,
      assetIds: [...assetIds],
      isDecedent: person.isDecedent,
    });
  }
  return out.sort((a, b) => b.photoCount - a.photoCount || (a.name < b.name ? -1 : 1));
}

/** Which photographs a named person is in. Drives the filter on the grid. */
export function assetIdsForPerson(db: Db, memorialId: string, personId: string): Set<string> {
  return new Set(
    listFaceDetections(db, memorialId)
      .filter((row) => row.personId === personId && row.dismissedAt == null)
      .map((row) => row.assetId),
  );
}
