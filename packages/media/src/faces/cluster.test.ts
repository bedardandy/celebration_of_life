/**
 * Clustering, against vectors written by hand.
 *
 * Synthetic on purpose: the question "are these the same person" is answered by
 * arithmetic, and arithmetic can be checked exactly. What the tests protect is
 * the asymmetry the module is built around — a person split in two is a small
 * annoyance, two people merged into one is a stranger in "photos of Ruth" — so
 * there is a test for each side of it.
 */
import { describe, expect, it } from 'vitest';
import {
  clusterFaces,
  cosineSimilarity,
  DEFAULT_CLUSTER_THRESHOLD,
  nearestCluster,
  normalize,
} from './cluster';

/** A unit vector pointing mostly along one axis, with a little noise. */
function near(axis: number, dims: number, wobble: number, seed = 1): number[] {
  const out = new Array<number>(dims).fill(0);
  out[axis] = 1;
  for (let i = 0; i < dims; i += 1) {
    out[i] = (out[i] as number) + wobble * Math.sin(seed * 7.13 + i * 1.7);
  }
  return normalize(out);
}

describe('cosine similarity', () => {
  it('is 1 for the same direction and 0 for a right angle', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('refuses to compare embeddings from two different models', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length/);
  });

  it('treats a zero vector as similar to nothing', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe('clusterFaces', () => {
  it('groups three photographs of one person and keeps another apart', () => {
    const faces = [
      { id: 'ruth-1', embedding: near(0, 16, 0.05, 1), quality: 0.9 },
      { id: 'ruth-2', embedding: near(0, 16, 0.05, 2), quality: 0.8 },
      { id: 'ruth-3', embedding: near(0, 16, 0.05, 3), quality: 0.7 },
      { id: 'harold-1', embedding: near(5, 16, 0.05, 4), quality: 0.85 },
    ];

    const { clusters } = clusterFaces(faces);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.memberIds).toEqual(['ruth-1', 'ruth-2', 'ruth-3']);
    expect(clusters[1]?.memberIds).toEqual(['harold-1']);
    // Biggest group first: the strip asks about the face that appears most.
    expect(clusters[0]?.size).toBe(3);
  });

  it('never merges two clearly different people', () => {
    const faces = Array.from({ length: 8 }, (_, i) => ({
      id: `face-${i}`,
      embedding: near(i % 4, 24, 0.04, i + 1),
      quality: 0.8,
    }));

    const { clusters } = clusterFaces(faces);

    expect(clusters).toHaveLength(4);
    for (const cluster of clusters) expect(cluster.size).toBe(2);
  });

  it('is deterministic: the same faces in a different order give the same groups', () => {
    const faces = [
      { id: 'a', embedding: near(0, 16, 0.06, 11), quality: 0.6 },
      { id: 'b', embedding: near(0, 16, 0.06, 12), quality: 0.9 },
      { id: 'c', embedding: near(3, 16, 0.06, 13), quality: 0.75 },
      { id: 'd', embedding: near(3, 16, 0.06, 14), quality: 0.5 },
    ];

    const forwards = clusterFaces(faces);
    const backwards = clusterFaces([...faces].reverse());

    expect(backwards.clusters.map((c) => c.memberIds)).toEqual(
      forwards.clusters.map((c) => c.memberIds),
    );
  });

  it('lets a poor face join a group but never start one', () => {
    const alone = clusterFaces([{ id: 'smudge', embedding: near(1, 16, 0.2, 5), quality: 0.1 }]);
    expect(alone.clusters).toHaveLength(0);
    expect(alone.unclustered).toEqual(['smudge']);

    const joined = clusterFaces([
      { id: 'clear', embedding: near(1, 16, 0.03, 6), quality: 0.9 },
      { id: 'smudge', embedding: near(1, 16, 0.05, 7), quality: 0.1 },
    ]);
    expect(joined.clusters[0]?.memberIds).toEqual(['clear', 'smudge']);
  });

  it('merges two groups whose centres drifted together as members arrived', () => {
    // A face photographed across sixty years can seed two groups — the young
    // one and the old one — when the two sharpest photographs happen to be the
    // two extremes. As the in-between photographs join, both centres move; the
    // merge pass is what notices they have met.
    const at = (degrees: number): number[] => {
      const radians = (degrees * Math.PI) / 180;
      return [Math.cos(radians), Math.sin(radians), 0, 0];
    };
    const faces = [
      { id: 'young-1', embedding: at(0), quality: 0.95 },
      { id: 'old-1', embedding: at(70), quality: 0.94 },
      { id: 'old-2', embedding: at(50), quality: 0.9 },
      { id: 'young-2', embedding: at(20), quality: 0.89 },
    ];

    const merged = clusterFaces(faces, { threshold: 0.62 });
    expect(merged.clusters).toHaveLength(1);
    expect(merged.clusters[0]?.size).toBe(4);

    // Held to a stricter standard they stay apart, which is the safe failure:
    // naming a group twice costs a moment, a stranger in the group costs trust.
    expect(clusterFaces(faces, { threshold: 0.75 }).clusters).toHaveLength(2);
  });

  it('drops empty and zero embeddings rather than dividing by zero', () => {
    const { clusters, unclustered } = clusterFaces([
      { id: 'good', embedding: near(0, 8, 0.02, 31), quality: 0.9 },
      { id: 'empty', embedding: [], quality: 0.9 },
      { id: 'zero', embedding: [0, 0, 0, 0, 0, 0, 0, 0], quality: 0.9 },
    ]);
    expect(clusters[0]?.memberIds).toEqual(['good']);
    expect(unclustered).toEqual(['empty', 'zero']);
  });

  it('holds back groups smaller than minSize when asked', () => {
    const { clusters, unclustered } = clusterFaces(
      [
        { id: 'a1', embedding: near(0, 12, 0.03, 41), quality: 0.9 },
        { id: 'a2', embedding: near(0, 12, 0.03, 42), quality: 0.9 },
        { id: 'b1', embedding: near(6, 12, 0.03, 43), quality: 0.9 },
      ],
      { minSize: 2 },
    );
    expect(clusters).toHaveLength(1);
    expect(unclustered).toEqual(['b1']);
  });
});

describe('nearestCluster', () => {
  it('places a late arrival in the group it belongs to', () => {
    const { clusters } = clusterFaces([
      { id: 'r1', embedding: near(0, 16, 0.03, 51), quality: 0.9 },
      { id: 'r2', embedding: near(0, 16, 0.03, 52), quality: 0.9 },
      { id: 'h1', embedding: near(7, 16, 0.03, 53), quality: 0.9 },
    ]);

    const match = nearestCluster(near(0, 16, 0.04, 54), clusters);
    expect(match?.cluster.memberIds).toContain('r1');
    expect(match?.similarity).toBeGreaterThan(DEFAULT_CLUSTER_THRESHOLD);

    expect(nearestCluster(near(11, 16, 0.03, 55), clusters)).toBeUndefined();
  });
});
