/**
 * The seam between "find the faces" and everything that uses them.
 *
 * There is exactly one rule behind this interface, and it is not a technical
 * one: **no face ever leaves the machine it was found on.** No third-party face
 * API is acceptable here at any price, because a grieving family handing over a
 * shoebox of photographs has not agreed to a biometric database of everyone who
 * ever stood next to their mother.
 *
 * So an engine is something that runs locally, and the interface is written so
 * that "there is no engine on this machine" is an ordinary, expected answer
 * rather than a failure: `available()` is asked first, and when it says no, the
 * feature is simply absent from the product. There are no dead buttons.
 */
import type { FaceBox } from '@col/schemas';

export type { FaceBox };

export type DetectedFace = {
  /** Where the face is, in 0..1 of the picture's own size. */
  box: FaceBox;
  /** The descriptor. Comparable only against embeddings from the same engine. */
  embedding: number[];
  /** 0..1: detector confidence, moderated by how big and how usable the face is. */
  quality: number;
};

export type DetectHints = {
  /** The filename as the family sent it. Never trusted; used by the mock engine. */
  filename?: string | null;
  assetId?: string;
};

export type EngineAvailability =
  | { available: true; note?: string }
  /** Why not, in a sentence an operator can act on. Never shown to a family. */
  | { available: false; reason: string };

export interface FaceEngine {
  /** 'mock' | 'onnx' | … — stored on every row so a model change is knowable. */
  readonly id: string;
  /**
   * Whether this engine can actually run here, right now. Cheap enough to call
   * at boot and honest enough to be trusted: it loads what it needs.
   */
  available(): Promise<EngineAvailability>;
  /** Faces in one already-upright image. Returns [] for a photograph with none. */
  detect(image: Buffer, hints?: DetectHints): Promise<DetectedFace[]>;
}

/** Faces smaller than this fraction of the frame are background, not people. */
export const MIN_FACE_FRACTION = 0.004;

/** Below this we keep the row but never let it start a cluster on its own. */
export const MIN_CLUSTER_QUALITY = 0.35;
