/**
 * A face engine with no model in it.
 *
 * Every test in this repo runs against this, and so does `FACE_ENGINE=mock` in
 * development, because the alternative — a 200 MB download and a native runtime
 * — is not something CI should depend on and not something a developer should
 * need before they can see the screen they are building.
 *
 * The trick is the filename. A fixture called `ruth-1962.jpg` and one called
 * `ruth-1988.jpg` get almost the same vector; `harold-1974.jpg` gets a very
 * different one. So the clustering, the naming, the filter chip and the
 * coverage nudge can all be exercised end to end, deterministically, with no
 * pixels involved — and nothing about the rest of the product knows or cares
 * that the faces were arithmetic rather than photographs.
 *
 * It is never a fallback for a real engine. `FACE_ENGINE` has to say `mock`.
 */
import { createHash } from 'node:crypto';
import type { DetectHints, DetectedFace, EngineAvailability, FaceEngine } from './types';

export const MOCK_EMBEDDING_DIMS = 64;

/** How far a single photograph's face wanders from its person's centre. */
const JITTER = 0.09;

/** Tiny deterministic PRNG (mulberry32), same one the photo fixtures use. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/**
 * The person this file is "of", by convention: the first word of the filename
 * once any numeric prefix is out of the way. `01-portrait.jpg` → `portrait`,
 * `ruth-1962.jpg` → `ruth`, `05-garden-near-duplicate.jpg` → `garden`.
 */
export function mockPersonToken(filename: string | null | undefined): string | undefined {
  if (!filename) return undefined;
  const base = (filename.split(/[\\/]/).pop() ?? filename)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '');
  const word = base.replace(/^[\d\s_-]+/, '').match(/^[a-z]+/)?.[0];
  return word && word.length > 1 ? word : undefined;
}

function unitVector(seed: number): number[] {
  const next = rng(seed);
  const raw: number[] = [];
  for (let i = 0; i < MOCK_EMBEDDING_DIMS; i += 1) raw.push(next() * 2 - 1);
  const length = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / length);
}

/** One person's centre, plus this photograph's own small deviation from it. */
export function mockEmbedding(personToken: string, variantKey: string): number[] {
  const base = unitVector(seedFrom(`person:${personToken}`));
  const drift = unitVector(seedFrom(`shot:${personToken}:${variantKey}`));
  const mixed = base.map((value, i) => value + JITTER * (drift[i] as number));
  const length = Math.sqrt(mixed.reduce((sum, v) => sum + v * v, 0)) || 1;
  return mixed.map((v) => v / length);
}

export type MockFaceEngineOptions = {
  /** Bytes are hashed for a token when a filename tells us nothing. */
  fallbackToBytes?: boolean;
};

export class MockFaceEngine implements FaceEngine {
  readonly id = 'mock';

  constructor(private readonly options: MockFaceEngineOptions = {}) {}

  async available(): Promise<EngineAvailability> {
    return { available: true, note: 'deterministic test engine — no model, no pixels' };
  }

  async detect(image: Buffer, hints: DetectHints = {}): Promise<DetectedFace[]> {
    const filename = hints.filename ?? undefined;
    const name = (filename ?? '').toLowerCase();

    // Two conventions, so tests can cover the shapes that matter: a photograph
    // with nobody in it, and a photograph with two people in it.
    if (name.includes('noface') || image.byteLength === 0) return [];
    const count = name.includes('group') ? 2 : 1;

    const token =
      mockPersonToken(filename) ??
      (this.options.fallbackToBytes === false
        ? undefined
        : createHash('sha256').update(image).digest('hex').slice(0, 8));
    if (!token) return [];

    const variantKey = filename ?? createHash('sha256').update(image).digest('hex').slice(0, 16);
    const next = rng(seedFrom(`quality:${variantKey}`));

    const faces: DetectedFace[] = [];
    for (let i = 0; i < count; i += 1) {
      // Two people in one photograph are two different people: the second face
      // belongs to `${token}-2`, which clusters on its own.
      const personToken = i === 0 ? token : `${token}-${i + 1}`;
      faces.push({
        box: {
          x: Math.round((0.18 + i * 0.34) * 1000) / 1000,
          y: 0.2,
          w: 0.24,
          h: 0.3,
        },
        embedding: mockEmbedding(personToken, variantKey),
        // Comfortably above the seeding floor, and varying, so ordering is
        // exercised rather than assumed.
        quality: Math.round((0.6 + next() * 0.35) * 1000) / 1000,
      });
    }
    return faces;
  }
}
