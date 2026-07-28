/**
 * The contract suite, wired up.
 *
 * CI runs it against the mock only — no binary, no key, no network, ever. A
 * developer with a Claude Code or Codex subscription runs the same suite
 * against the real thing with:
 *
 *   AI_LIVE_TEST=1 pnpm vitest run --project ai
 *   AI_LIVE_TEST=1 AI_LIVE_TEST_PROVIDERS=claude-cli pnpm vitest run --project ai
 *
 * Adapters that are not installed or not keyed are skipped by name rather than
 * failing, so "run the live suite" is a safe thing to type on any machine.
 */
import { beforeEach, describe, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Via the package entry point: that is where the adapters get registered.
import { MOCK_PROVIDER_ID, getProvider, hasProvider, isCheckable, resetMockState } from '../index';
import { describeProviderContract, liveProviderIds, liveTestingEnabled } from './contract-suite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturePhoto = path.join(repoRoot, 'fixtures', 'photos', '01-portrait.jpg');
const photo = existsSync(fixturePhoto) ? fixturePhoto : undefined;

beforeEach(() => {
  resetMockState();
});

describeProviderContract(MOCK_PROVIDER_ID, {
  provider: () => getProvider(MOCK_PROVIDER_ID),
  ...(photo ? { fixturePhoto: photo } : {}),
  // Both cases live in fixtures/ai/edl/.
  fixtureTaskTag: 'edl',
  repairPrompt: 'give me the broken once case',
  unfixablePrompt: 'give me the unfixable case',
});

if (liveTestingEnabled()) {
  for (const id of liveProviderIds()) {
    if (!hasProvider(id)) {
      describe(`${id} provider contract`, () => {
        it.skip(`is not a registered adapter`, () => {});
      });
      continue;
    }
    const provider = getProvider(id);
    const availability = isCheckable(provider) ? provider.checkAvailability() : { ok: true };
    if (!availability.ok) {
      describe(`${id} provider contract`, () => {
        it.skip(`skipped: ${availability.reason ?? 'unavailable'}`, () => {});
      });
      continue;
    }
    describeProviderContract(id, {
      provider: () => provider,
      ...(photo ? { fixturePhoto: photo } : {}),
      timeoutMs: 180_000,
    });
  }
} else {
  describe('live provider contract', () => {
    it.skip('set AI_LIVE_TEST=1 to run the contract suite against real adapters', () => {});
  });
}
