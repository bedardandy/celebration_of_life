/**
 * The real face engine: two small ONNX models, on this machine, offline.
 *
 * Nothing is downloaded here, ever. The models are files an operator put in
 * `FACE_MODEL_DIR` on purpose (docs/face-grouping.md says which ones and where
 * they come from), and if they are not there this engine reports
 * `available: false` and the entire feature disappears from the product rather
 * than degrading into a broken button.
 *
 * Two networks:
 *  - a detector (SCRFD) that says where the faces are;
 *  - an embedder (ArcFace/MobileFaceNet) that turns each face into a vector.
 *
 * The index arithmetic that turns detector output into rectangles lives in
 * `scrfd.ts` and is unit-tested without any model at all, because that is the
 * part that goes quietly wrong.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import type { DetectHints, DetectedFace, EngineAvailability, FaceEngine } from './types';
import { MIN_FACE_FRACTION } from './types';
import {
  boxToFraction,
  decodeScrfdStride,
  letterbox,
  nonMaximumSuppression,
  type ScoredBox,
} from './scrfd';

/* -------------------------------------------------------------------------- */
/* the shape of onnxruntime, without depending on it                           */
/* -------------------------------------------------------------------------- */

type OrtTensorData = Float32Array | Int32Array | Uint8Array;

type OrtTensor = { data: OrtTensorData; dims: readonly number[] };

type OrtSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};

type OrtModule = {
  InferenceSession: { create(path: string, options?: unknown): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
};

/**
 * Loaded at runtime, never at build time.
 *
 * The specifier is assembled rather than written as a literal so that bundlers
 * (Next's, in the web app) leave it alone: the web process must never try to
 * load a native runtime it has no use for. `onnxruntime-node` is an optional
 * dependency, so "not installed" is a supported state, not a broken install.
 */
async function loadOrt(): Promise<OrtModule> {
  const specifier = ['onnxruntime', 'node'].join('-');
  return (await import(/* webpackIgnore: true */ specifier)) as unknown as OrtModule;
}

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

/** InsightFace's buffalo_s pack, which is the smallest sensible pair. */
export const DEFAULT_DETECTOR_FILE = 'det_500m.onnx';
export const DEFAULT_EMBEDDER_FILE = 'w600k_mbf.onnx';

export const DETECTOR_INPUT = 640;
export const EMBEDDER_INPUT = 112;

/** Below this the detector is guessing. Faces at a funeral are not adversarial. */
export const DETECTION_THRESHOLD = 0.5;

export type OnnxFaceEngineOptions = {
  modelDir?: string;
  detectorFile?: string;
  embedderFile?: string;
  threshold?: number;
};

export function onnxOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OnnxFaceEngineOptions {
  return {
    ...(env['FACE_MODEL_DIR']?.trim() ? { modelDir: env['FACE_MODEL_DIR'].trim() } : {}),
    ...(env['FACE_DETECTOR_MODEL']?.trim()
      ? { detectorFile: env['FACE_DETECTOR_MODEL'].trim() }
      : {}),
    ...(env['FACE_EMBEDDER_MODEL']?.trim()
      ? { embedderFile: env['FACE_EMBEDDER_MODEL'].trim() }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* the engine                                                                  */
/* -------------------------------------------------------------------------- */

export class OnnxFaceEngine implements FaceEngine {
  readonly id = 'onnx';

  private detector?: OrtSession;
  private embedder?: OrtSession;
  private ort?: OrtModule;
  private probe?: Promise<EngineAvailability>;

  constructor(private readonly options: OnnxFaceEngineOptions = {}) {}

  get modelDir(): string | undefined {
    return this.options.modelDir;
  }

  detectorPath(): string | undefined {
    if (!this.options.modelDir) return undefined;
    return path.resolve(this.options.modelDir, this.options.detectorFile ?? DEFAULT_DETECTOR_FILE);
  }

  embedderPath(): string | undefined {
    if (!this.options.modelDir) return undefined;
    return path.resolve(this.options.modelDir, this.options.embedderFile ?? DEFAULT_EMBEDDER_FILE);
  }

  /** Asked once at boot. Loads the runtime and both models, or explains why not. */
  async available(): Promise<EngineAvailability> {
    this.probe ??= this.runProbe();
    return this.probe;
  }

  private async runProbe(): Promise<EngineAvailability> {
    const detectorPath = this.detectorPath();
    const embedderPath = this.embedderPath();
    if (!detectorPath || !embedderPath) {
      return {
        available: false,
        reason:
          'FACE_MODEL_DIR is not set, so there are no face models to load. ' +
          'See docs/face-grouping.md for which two files to put there.',
      };
    }
    for (const file of [detectorPath, embedderPath]) {
      if (!existsSync(file)) {
        return { available: false, reason: `Face model file not found: ${file}` };
      }
    }

    try {
      this.ort = await loadOrt();
    } catch (error) {
      return {
        available: false,
        reason:
          'onnxruntime-node is not installed or could not load on this machine ' +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          'Run `pnpm add -O onnxruntime-node` in packages/media, or leave face grouping off.',
      };
    }

    try {
      this.detector = await this.ort.InferenceSession.create(detectorPath);
      this.embedder = await this.ort.InferenceSession.create(embedderPath);
    } catch (error) {
      return {
        available: false,
        reason: `The face models could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    return {
      available: true,
      note: `${path.basename(detectorPath)} + ${path.basename(embedderPath)}`,
    };
  }

  async detect(image: Buffer, _hints: DetectHints = {}): Promise<DetectedFace[]> {
    const status = await this.available();
    if (!status.available) throw new Error(status.reason);
    const ort = this.ort as OrtModule;
    const detector = this.detector as OrtSession;
    const embedder = this.embedder as OrtSession;

    const source = sharp(image, { failOn: 'none' }).rotate();
    const meta = await source.metadata();
    const sourceWidth = meta.width ?? 0;
    const sourceHeight = meta.height ?? 0;
    if (!sourceWidth || !sourceHeight) return [];

    const frame = letterbox(sourceWidth, sourceHeight, DETECTOR_INPUT);
    const canvas = await sharp(image, { failOn: 'none' })
      .rotate()
      .resize(frame.width, frame.height, { fit: 'fill' })
      .extend({
        top: frame.padY,
        left: frame.padX,
        bottom: DETECTOR_INPUT - frame.height - frame.padY,
        right: DETECTOR_INPUT - frame.width - frame.padX,
        background: { r: 0, g: 0, b: 0 },
      })
      .removeAlpha()
      .raw()
      .toBuffer();

    const feeds: Record<string, OrtTensor> = {
      [detector.inputNames[0] as string]: new ort.Tensor(
        'float32',
        toNchw(canvas, DETECTOR_INPUT, DETECTOR_INPUT, 127.5, 128),
        [1, 3, DETECTOR_INPUT, DETECTOR_INPUT],
      ),
    };
    const outputs = await detector.run(feeds);
    const boxes = decodeDetector(outputs, this.options.threshold ?? DETECTION_THRESHOLD);

    const faces: DetectedFace[] = [];
    for (const box of nonMaximumSuppression(boxes)) {
      const fraction = boxToFraction(box, frame, sourceWidth, sourceHeight);
      if (fraction.w * fraction.h < MIN_FACE_FRACTION) continue;

      const crop = await cropFace(image, fraction, sourceWidth, sourceHeight);
      if (!crop) continue;

      const embedFeeds: Record<string, OrtTensor> = {
        [embedder.inputNames[0] as string]: new ort.Tensor(
          'float32',
          toNchw(crop, EMBEDDER_INPUT, EMBEDDER_INPUT, 127.5, 127.5),
          [1, 3, EMBEDDER_INPUT, EMBEDDER_INPUT],
        ),
      };
      const embedded = await embedder.run(embedFeeds);
      const vector = firstFloatTensor(embedded);
      if (!vector) continue;

      faces.push({
        box: fraction,
        embedding: unit(Array.from(vector)),
        // Confidence, held back by faces that are small in the frame: a face
        // twelve pixels across at the back of a wedding group is a real face
        // and a poor witness to who it belongs to.
        quality: round(Math.min(1, box.score) * sizeFactor(fraction)),
      });
    }
    return faces;
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Interleaved RGB bytes → planar float NCHW, scaled the way the model wants. */
export function toNchw(
  rgb: Buffer,
  width: number,
  height: number,
  mean: number,
  scale: number,
): Float32Array {
  const pixels = width * height;
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    out[i] = ((rgb[i * 3] as number) - mean) / scale;
    out[pixels + i] = ((rgb[i * 3 + 1] as number) - mean) / scale;
    out[2 * pixels + i] = ((rgb[i * 3 + 2] as number) - mean) / scale;
  }
  return out;
}

/**
 * Group the detector's nine output tensors into (scores, distances) per stride.
 *
 * Exported models name these things inconsistently — `score_8`, `448`,
 * `scores_stride8` — so they are identified by shape instead: a trailing 1 is
 * scores, a trailing 4 is box distances, a trailing 10 is landmarks (which we
 * do not use). Within each kind, the biggest tensor is stride 8.
 */
export function decodeDetector(
  outputs: Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
  threshold: number,
  inputSize: number = DETECTOR_INPUT,
): ScoredBox[] {
  const scores: { data: ArrayLike<number>; count: number }[] = [];
  const distances: { data: ArrayLike<number>; count: number }[] = [];

  for (const tensor of Object.values(outputs)) {
    const last = tensor.dims[tensor.dims.length - 1] ?? 1;
    const count = tensor.data.length / last;
    if (last === 1) scores.push({ data: tensor.data, count });
    else if (last === 4) distances.push({ data: tensor.data, count });
  }

  scores.sort((a, b) => b.count - a.count);
  distances.sort((a, b) => b.count - a.count);

  const strides = [8, 16, 32];
  const boxes: ScoredBox[] = [];
  for (let i = 0; i < Math.min(scores.length, distances.length, strides.length); i += 1) {
    boxes.push(
      ...decodeScrfdStride({
        scores: (scores[i] as { data: ArrayLike<number> }).data,
        distances: (distances[i] as { data: ArrayLike<number> }).data,
        stride: strides[i] as number,
        inputWidth: inputSize,
        inputHeight: inputSize,
        threshold,
      }),
    );
  }
  return boxes;
}

/** A square crop around the face, a little wider than the box, at 112×112. */
async function cropFace(
  image: Buffer,
  fraction: { x: number; y: number; w: number; h: number },
  sourceWidth: number,
  sourceHeight: number,
): Promise<Buffer | undefined> {
  const cx = (fraction.x + fraction.w / 2) * sourceWidth;
  const cy = (fraction.y + fraction.h / 2) * sourceHeight;
  const size = Math.max(fraction.w * sourceWidth, fraction.h * sourceHeight) * 1.3;
  const left = Math.round(Math.max(0, Math.min(sourceWidth - 1, cx - size / 2)));
  const top = Math.round(Math.max(0, Math.min(sourceHeight - 1, cy - size / 2)));
  const width = Math.round(Math.min(size, sourceWidth - left));
  const height = Math.round(Math.min(size, sourceHeight - top));
  if (width < 8 || height < 8) return undefined;

  return sharp(image, { failOn: 'none' })
    .rotate()
    .extract({ left, top, width, height })
    .resize(EMBEDDER_INPUT, EMBEDDER_INPUT, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

function firstFloatTensor(
  outputs: Record<string, { data: ArrayLike<number> }>,
): ArrayLike<number> | undefined {
  const first = Object.values(outputs)[0];
  return first?.data;
}

function unit(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return length === 0 ? vector : vector.map((v) => v / length);
}

function sizeFactor(fraction: { w: number; h: number }): number {
  const area = fraction.w * fraction.h;
  // Full marks at about 6% of the frame; a gentle ramp below that.
  return Math.min(1, Math.sqrt(area / 0.06));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
