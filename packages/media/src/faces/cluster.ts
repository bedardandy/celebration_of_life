/**
 * Which faces are the same person, decided with arithmetic only.
 *
 * No model runs in this file. It takes vectors and gives back groups, which is
 * what makes the whole feature testable without a 200 MB download and what
 * makes swapping the detector a change of one module rather than of the
 * product's behaviour.
 *
 * The method is deliberately the simple one — greedy assignment to the nearest
 * cluster centroid by cosine similarity, then a merge pass to undo the damage
 * that greedy ordering does — because the consequences of getting it wrong are
 * asymmetric and both of them are survivable:
 *
 *  - splitting one person into two groups asks the organiser to type a name
 *    twice, which is a small annoyance;
 *  - merging two people into one group puts a stranger in "photos of Ruth",
 *    which is worse. So the threshold errs high, the strip says "these *look
 *    like* the same person" rather than asserting it, and every group is
 *    something a person confirms rather than something we decide.
 *
 * Nothing here is ever applied automatically to a photograph.
 */

export type ClusterInput = {
  /** Row id, or any stable identifier. Ordering ties break on it, so it matters. */
  id: string;
  embedding: readonly number[];
  /** 0..1. Low-quality faces may join a group but may never start one. */
  quality?: number;
};

export type FaceCluster = {
  /** 'c1', 'c2' — a label from this pass, not an identity. See face_detections. */
  id: string;
  memberIds: string[];
  /** Unit-length mean of the members. Handy for assigning late arrivals. */
  centroid: number[];
  size: number;
};

export type ClusterResult = {
  clusters: FaceCluster[];
  /** Faces too poor or too unlike anything else to be worth showing. */
  unclustered: string[];
};

export type ClusterOptions = {
  /**
   * Cosine similarity at which two faces are called the same person.
   *
   * 0.62 suits ArcFace-style embeddings (which run ~0.3 between strangers and
   * ~0.7 between two photographs of one person) and is what the mock engine is
   * tuned around. It is an option because a different embedder needs a
   * different number, and finding that number is an operator's job, not a
   * family's — see docs/face-grouping.md.
   */
  threshold?: number;
  /** A face below this may join a group but never seeds one. */
  minSeedQuality?: number;
  /** Groups smaller than this are returned as `unclustered` instead. */
  minSize?: number;
};

export const DEFAULT_CLUSTER_THRESHOLD = 0.62;
export const DEFAULT_MIN_SEED_QUALITY = 0.35;

/** Length of a vector; 0 for an empty or degenerate one. */
export function magnitude(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/** Unit-length copy. A zero vector stays zero rather than becoming NaN. */
export function normalize(vector: readonly number[]): number[] {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length === 0) return vector.map(() => 0);
  return vector.map((value) => value / length);
}

/**
 * Cosine similarity, in −1..1. Vectors of different lengths cannot be compared
 * — that means two different models — so this says so rather than guessing.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cannot compare embeddings of length ${a.length} and ${b.length}`);
  }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

type Working = {
  memberIds: string[];
  /** Running sum of unit vectors; the centroid is this, normalised. */
  sum: number[];
};

function centroidOf(cluster: Working): number[] {
  return normalize(cluster.sum);
}

/**
 * Group faces. Deterministic: the same input always produces the same groups,
 * with the same ids, in the same order — which is what stops a strip of
 * suggestions reshuffling under somebody's hand between two taps.
 */
export function clusterFaces(
  faces: readonly ClusterInput[],
  options: ClusterOptions = {},
): ClusterResult {
  const threshold = options.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const minSeedQuality = options.minSeedQuality ?? DEFAULT_MIN_SEED_QUALITY;
  const minSize = options.minSize ?? 1;

  const usable = faces.filter((face) => face.embedding.length > 0 && magnitude(face.embedding) > 0);
  if (usable.length === 0) return { clusters: [], unclustered: faces.map((f) => f.id) };

  const width = (usable[0] as ClusterInput).embedding.length;
  const sameWidth = usable.filter((face) => face.embedding.length === width);
  const wrongWidth = usable.filter((face) => face.embedding.length !== width).map((f) => f.id);

  // Best faces first: a clear, well-lit face makes a better centre for a group
  // than a blurry three-quarter one, and greedy assignment is only as good as
  // the order it sees.
  const ordered = [...sameWidth].sort(
    (a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const working: Working[] = [];
  const leftovers: string[] = [];

  for (const face of ordered) {
    const unit = normalize(face.embedding);
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < working.length; i += 1) {
      const score = cosineSimilarity(unit, centroidOf(working[i] as Working));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= threshold) {
      const cluster = working[bestIndex] as Working;
      cluster.memberIds.push(face.id);
      for (let i = 0; i < width; i += 1) {
        cluster.sum[i] = (cluster.sum[i] as number) + (unit[i] as number);
      }
      continue;
    }

    if ((face.quality ?? 1) < minSeedQuality) {
      leftovers.push(face.id);
      continue;
    }
    working.push({ memberIds: [face.id], sum: [...unit] });
  }

  mergeClose(working, threshold, width);

  // Biggest first — the group with fourteen photographs of one face is the one
  // worth asking about — then oldest member id, so ties never wobble.
  const ranked = working.sort(
    (a, b) =>
      b.memberIds.length - a.memberIds.length ||
      ((a.memberIds[0] as string) < (b.memberIds[0] as string) ? -1 : 1),
  );

  const clusters: FaceCluster[] = [];
  const unclustered: string[] = [...leftovers, ...wrongWidth, ...faces.filter(unusable).map(idOf)];

  let index = 0;
  for (const cluster of ranked) {
    if (cluster.memberIds.length < minSize) {
      unclustered.push(...cluster.memberIds);
      continue;
    }
    index += 1;
    clusters.push({
      id: `c${index}`,
      memberIds: [...cluster.memberIds].sort(),
      centroid: centroidOf(cluster),
      size: cluster.memberIds.length,
    });
  }

  return { clusters, unclustered: [...new Set(unclustered)].sort() };
}

const idOf = (face: ClusterInput): string => face.id;
const unusable = (face: ClusterInput): boolean =>
  face.embedding.length === 0 || magnitude(face.embedding) === 0;

/**
 * The repair pass for greedy assignment.
 *
 * A person photographed across sixty years can seed two groups — the young face
 * and the old one — if the young photographs happen to arrive first and no
 * single face bridges them. Comparing whole centroids afterwards, repeatedly
 * until nothing moves, catches most of that without loosening the threshold
 * that keeps two different people apart.
 */
function mergeClose(clusters: Working[], threshold: number, width: number): void {
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = clusters[i] as Working;
        const b = clusters[j] as Working;
        if (cosineSimilarity(centroidOf(a), centroidOf(b)) < threshold) continue;
        a.memberIds.push(...b.memberIds);
        for (let k = 0; k < width; k += 1) {
          a.sum[k] = (a.sum[k] as number) + (b.sum[k] as number);
        }
        clusters.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
}

/**
 * Which existing group a new face belongs to, if any.
 *
 * Used when photographs arrive after a grouping pass: re-running the whole
 * clustering would renumber every label, and a family who has already named a
 * group should not watch that happen.
 */
export function nearestCluster(
  embedding: readonly number[],
  clusters: readonly FaceCluster[],
  threshold: number = DEFAULT_CLUSTER_THRESHOLD,
): { cluster: FaceCluster; similarity: number } | undefined {
  const unit = normalize(embedding);
  let best: { cluster: FaceCluster; similarity: number } | undefined;
  for (const cluster of clusters) {
    if (cluster.centroid.length !== unit.length) continue;
    const similarity = cosineSimilarity(unit, cluster.centroid);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { cluster, similarity };
    }
  }
  return best;
}
