import { fixturesArePresent, makeFixtures } from './make-fixtures';

/**
 * Vitest global setup. Keeps the test run hermetic:
 *  - forces the deterministic mock AI provider (no network, ever, in tests)
 *  - materialises the photo fixture set if it is missing
 */
export default async function setup(): Promise<void> {
  process.env.AI_PROVIDER ??= 'mock';
  // The deterministic face engine, for the same reason: no model download, no
  // native runtime, and the same groups on every machine.
  process.env.FACE_ENGINE ??= 'mock';
  if (!(await fixturesArePresent())) {
    await makeFixtures();
  }
}
