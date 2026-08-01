/**
 * Choosing a face engine, and being honest when there is not one.
 *
 * `FACE_ENGINE` is off unless somebody sets it. That is the important default:
 * face grouping is the most invasive-sounding thing in this product, so it does
 * not appear because a package happened to install — it appears because an
 * operator configured it and an organiser then asked for it.
 *
 * Two kinds of question get asked here, and they are different on purpose:
 *
 *  - `faceEngineConfigured()` is cheap, synchronous and never loads anything.
 *    The web app asks it to decide whether the feature exists on a screen at
 *    all, and a page render must not be waiting on a native runtime.
 *  - `probeFaceEngine()` actually loads the runtime and the models. The worker
 *    asks it at boot and the answer goes in the log.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MockFaceEngine } from './mock';
import {
  OnnxFaceEngine,
  onnxOptionsFromEnv,
  DEFAULT_DETECTOR_FILE,
  DEFAULT_EMBEDDER_FILE,
} from './onnx';
import type { EngineAvailability, FaceEngine } from './types';

export * from './types';
export * from './cluster';
export * from './scrfd';
export { MockFaceEngine, mockPersonToken, mockEmbedding, MOCK_EMBEDDING_DIMS } from './mock';
export {
  OnnxFaceEngine,
  onnxOptionsFromEnv,
  DEFAULT_DETECTOR_FILE,
  DEFAULT_EMBEDDER_FILE,
  DETECTOR_INPUT,
  EMBEDDER_INPUT,
  DETECTION_THRESHOLD,
} from './onnx';

export type FaceEngineSetting = 'off' | 'mock' | 'onnx';

export function faceEngineSetting(env: NodeJS.ProcessEnv = process.env): FaceEngineSetting {
  const raw = env['FACE_ENGINE']?.trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'none' || raw === 'false') return 'off';
  if (raw === 'mock' || raw === 'onnx') return raw;
  throw new Error(`FACE_ENGINE=${JSON.stringify(raw)} is not one of: off, mock, onnx.`);
}

/**
 * Could face grouping work here? File checks only — no model is opened, no
 * native module is loaded, and this is safe to call from a React server
 * component on every request.
 */
export function faceEngineConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = faceEngineSetting(env);
  if (setting === 'off') return false;
  if (setting === 'mock') return true;
  const options = onnxOptionsFromEnv(env);
  if (!options.modelDir) return false;
  return [
    options.detectorFile ?? DEFAULT_DETECTOR_FILE,
    options.embedderFile ?? DEFAULT_EMBEDDER_FILE,
  ].every((file) => existsSync(path.resolve(options.modelDir as string, file)));
}

/** The engine this process would use, or nothing at all. */
export function resolveFaceEngine(env: NodeJS.ProcessEnv = process.env): FaceEngine | undefined {
  switch (faceEngineSetting(env)) {
    case 'mock':
      return new MockFaceEngine();
    case 'onnx':
      return new OnnxFaceEngine(onnxOptionsFromEnv(env));
    default:
      return undefined;
  }
}

export type FaceEngineProbe = {
  setting: FaceEngineSetting;
  engine?: FaceEngine;
  status: EngineAvailability;
};

/** The boot-time question, with the loading actually done. */
export async function probeFaceEngine(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FaceEngineProbe> {
  const setting = faceEngineSetting(env);
  const engine = resolveFaceEngine(env);
  if (!engine) {
    return {
      setting,
      status: {
        available: false,
        reason: 'FACE_ENGINE is off. Face grouping is not offered to anybody.',
      },
    };
  }
  const status = await engine.available();
  return { setting, engine, status };
}
