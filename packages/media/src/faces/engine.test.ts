/**
 * The engines, and the promise that there is no engine unless somebody said so.
 *
 * Nothing here downloads a model, and nothing here can: the ONNX engine is
 * asked about a directory that does not exist, and the answer it gives — a
 * sentence an operator can act on — is the thing under test. That is the whole
 * design. A machine without models is a machine where face grouping simply does
 * not appear.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clusterFaces } from './cluster';
import { MockFaceEngine, mockPersonToken } from './mock';
import { OnnxFaceEngine } from './onnx';
import {
  faceEngineConfigured,
  faceEngineSetting,
  probeFaceEngine,
  resolveFaceEngine,
} from './index';
import { decodeScrfdStride, letterbox, nonMaximumSuppression, boxToFraction } from './scrfd';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'col-faces-'));
  scratch.push(dir);
  return dir;
}

/* -------------------------------------------------------------------------- */

describe('the mock engine', () => {
  const engine = new MockFaceEngine();

  it('reads a person out of the filename', () => {
    expect(mockPersonToken('01-portrait.jpg')).toBe('portrait');
    expect(mockPersonToken('ruth-1962.jpg')).toBe('ruth');
    expect(mockPersonToken('/tmp/x/05-garden-near-duplicate.jpg')).toBe('garden');
    expect(mockPersonToken('1975.jpg')).toBeUndefined();
    expect(mockPersonToken(null)).toBeUndefined();
  });

  it('gives two photographs of one person nearly the same vector', async () => {
    const [first] = await engine.detect(bytes('a'), { filename: 'ruth-1962.jpg' });
    const [second] = await engine.detect(bytes('b'), { filename: 'ruth-1988.jpg' });
    const [other] = await engine.detect(bytes('c'), { filename: 'harold-1974.jpg' });

    const { clusters } = clusterFaces([
      { id: 'a', embedding: first?.embedding ?? [], quality: first?.quality ?? 0 },
      { id: 'b', embedding: second?.embedding ?? [], quality: second?.quality ?? 0 },
      { id: 'c', embedding: other?.embedding ?? [], quality: other?.quality ?? 0 },
    ]);

    expect(clusters[0]?.memberIds).toEqual(['a', 'b']);
    expect(clusters[1]?.memberIds).toEqual(['c']);
  });

  it('is deterministic', async () => {
    const once = await engine.detect(bytes('x'), { filename: 'ruth-1962.jpg' });
    const twice = await engine.detect(bytes('x'), { filename: 'ruth-1962.jpg' });
    expect(twice).toEqual(once);
  });

  it('finds two people in a group photograph and nobody in an empty room', async () => {
    expect(await engine.detect(bytes('x'), { filename: 'ruth-group-1970.jpg' })).toHaveLength(2);
    expect(await engine.detect(bytes('x'), { filename: 'noface-house.jpg' })).toHaveLength(0);
    expect(await engine.detect(Buffer.alloc(0), { filename: 'ruth-1962.jpg' })).toHaveLength(0);
  });

  it('boxes faces inside the picture', async () => {
    const faces = await engine.detect(bytes('x'), { filename: 'ruth-group-1970.jpg' });
    for (const face of faces) {
      expect(face.box.x).toBeGreaterThanOrEqual(0);
      expect(face.box.x + face.box.w).toBeLessThanOrEqual(1);
      expect(face.box.y + face.box.h).toBeLessThanOrEqual(1);
      expect(face.quality).toBeGreaterThan(0.35);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the onnx engine, on a machine with no models', () => {
  it('says which environment variable is missing', async () => {
    const engine = new OnnxFaceEngine({});
    const status = await engine.available();
    expect(status.available).toBe(false);
    if (!status.available) expect(status.reason).toMatch(/FACE_MODEL_DIR/);
  });

  it('names the file it could not find', async () => {
    const dir = tempDir();
    const engine = new OnnxFaceEngine({ modelDir: dir });
    const status = await engine.available();
    expect(status.available).toBe(false);
    if (!status.available) expect(status.reason).toMatch(/det_500m\.onnx/);
  });

  it('refuses to detect rather than pretending it found nobody', async () => {
    const engine = new OnnxFaceEngine({ modelDir: tempDir() });
    await expect(engine.detect(bytes('x'))).rejects.toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */

describe('choosing an engine', () => {
  it('is off unless somebody sets FACE_ENGINE', () => {
    expect(faceEngineSetting({})).toBe('off');
    expect(faceEngineConfigured({})).toBe(false);
    expect(resolveFaceEngine({})).toBeUndefined();
  });

  it('rejects a setting nobody implemented rather than silently doing nothing', () => {
    expect(() => faceEngineSetting({ FACE_ENGINE: 'insightface' })).toThrow(/off, mock, onnx/);
  });

  it('treats onnx as unconfigured until both model files are on disk', () => {
    const dir = tempDir();
    const env = { FACE_ENGINE: 'onnx', FACE_MODEL_DIR: dir } as NodeJS.ProcessEnv;
    expect(faceEngineConfigured(env)).toBe(false);

    writeFileSync(path.join(dir, 'det_500m.onnx'), 'not really a model');
    expect(faceEngineConfigured(env)).toBe(false);
    writeFileSync(path.join(dir, 'w600k_mbf.onnx'), 'not really a model either');
    expect(faceEngineConfigured(env)).toBe(true);
  });

  it('probes to a usable engine when the mock is asked for', async () => {
    const probe = await probeFaceEngine({ FACE_ENGINE: 'mock' });
    expect(probe.status.available).toBe(true);
    expect(probe.engine?.id).toBe('mock');
  });

  it('probes to an explanation when face grouping is off', async () => {
    const probe = await probeFaceEngine({});
    expect(probe.status.available).toBe(false);
    expect(probe.engine).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('SCRFD decoding, without a model', () => {
  it('turns anchor distances into a box in input pixels', () => {
    // A 16×16 input at stride 8 → a 2×2 feature map, 2 anchors each = 8 rows.
    const scores = new Float32Array(8);
    const distances = new Float32Array(32);
    // Second position of the first row (col 1, row 0), first anchor → index 2.
    scores[2] = 0.9;
    distances.set([0.5, 0.5, 0.5, 0.5], 2 * 4);

    const boxes = decodeScrfdStride({
      scores,
      distances,
      stride: 8,
      inputWidth: 16,
      inputHeight: 16,
    });

    expect(boxes).toHaveLength(1);
    // Centre (8, 0), half a stride out in each direction.
    expect(boxes[0]).toMatchObject({ x1: 4, y1: -4, x2: 12, y2: 4 });
    expect(boxes[0]?.score).toBeCloseTo(0.9, 5);
  });

  it('ignores anything below the threshold', () => {
    const scores = new Float32Array([0.9, 0.2, 0.49, 0.51, 0, 0, 0, 0]);
    const distances = new Float32Array(32).fill(0.25);
    const boxes = decodeScrfdStride({
      scores,
      distances,
      stride: 8,
      inputWidth: 16,
      inputHeight: 16,
      threshold: 0.5,
    });
    expect(boxes).toHaveLength(2);
  });

  it('keeps the strongest of a pile of overlapping boxes', () => {
    const kept = nonMaximumSuppression([
      { x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9 },
      { x1: 1, y1: 1, x2: 11, y2: 11, score: 0.8 },
      { x1: 40, y1: 40, x2: 50, y2: 50, score: 0.7 },
    ]);
    expect(kept.map((b) => b.score)).toEqual([0.9, 0.7]);
  });

  it('maps a letterboxed box back onto the original photograph', () => {
    const frame = letterbox(1000, 500, 640);
    expect(frame.scale).toBeCloseTo(0.64, 5);
    expect(frame.padY).toBe(160);

    const box = { x1: 320, y1: 160 + 64, x2: 384, y2: 160 + 128, score: 0.9 };
    const fraction = boxToFraction(box, frame, 1000, 500);
    expect(fraction.x).toBeCloseTo(0.5, 5);
    expect(fraction.y).toBeCloseTo(0.2, 5);
    expect(fraction.w).toBeCloseTo(0.1, 5);
    expect(fraction.h).toBeCloseTo(0.2, 5);
  });

  it('clamps a chin predicted below the bottom of the picture', () => {
    const frame = letterbox(640, 640, 640);
    const fraction = boxToFraction(
      { x1: -50, y1: 600, x2: 60, y2: 900, score: 0.9 },
      frame,
      640,
      640,
    );
    expect(fraction.x).toBe(0);
    expect(fraction.y + fraction.h).toBeLessThanOrEqual(1);
  });
});
