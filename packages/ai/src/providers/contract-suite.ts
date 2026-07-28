/**
 * The contract every adapter has to keep.
 *
 * One suite, run against the mock in CI and against real adapters when someone
 * sets `AI_LIVE_TEST=1`. The value is not in the individual assertions — it is
 * in there being exactly one definition of "behaves like a provider", so a new
 * adapter is a config line rather than a new set of tests somebody has to
 * remember to write.
 *
 * This file imports from vitest but is not itself a test file; `contract.test.ts`
 * is what actually runs it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateObject } from '../generate-object';
import { isCheckable, type AiProvider } from '../types';

/** A toy shape, matching the committed `fixtures/ai/edl/` cases. */
export const ContractSchema = z
  .object({
    title: z.string().min(1),
    slideCount: z.number().int().min(0),
    beatSnapped: z.boolean(),
  })
  .strict();

export type ContractOptions = {
  /** Resolved lazily so a missing binary is a skipped suite, not a crash. */
  provider: () => AiProvider;
  /** A real image on disk. Without one the vision case is skipped. */
  fixturePhoto?: string;
  /**
   * A request that the provider is known to answer with broken JSON once and
   * valid JSON on the retry. Only the mock can promise this.
   */
  repairPrompt?: string;
  /** A request the provider will never answer with valid JSON. */
  unfixablePrompt?: string;
  /** Task tag those two prompts need, when their fixtures live under one. */
  fixtureTaskTag?: string;
  /** Live adapters are slow; the mock is instant. */
  timeoutMs?: number;
};

export function describeProviderContract(name: string, options: ContractOptions): void {
  describe(`${name} provider contract`, () => {
    const timeout = options.timeoutMs ?? 5_000;

    it(
      'completes plain text',
      async () => {
        const provider = options.provider();
        const result = await provider.complete({
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          taskTag: 'contract',
        });
        expect(typeof result.text).toBe('string');
        expect(result.text.trim().length).toBeGreaterThan(0);
      },
      timeout,
    );

    it('declares capabilities that are internally consistent', () => {
      const capabilities = options.provider().capabilities;
      expect(capabilities.text).toBe(true);
      if (!capabilities.vision) expect(capabilities.visionInput).toBe('none');
      if (capabilities.vision) expect(capabilities.maxImagesPerCall).toBeGreaterThan(0);
      expect(['subscription', 'metered', 'free']).toContain(capabilities.costTier);
    });

    it('says plainly whether it can run at all', () => {
      const provider = options.provider();
      if (!isCheckable(provider)) return;
      const availability = provider.checkAvailability();
      expect(typeof availability.ok).toBe('boolean');
      if (!availability.ok) expect(availability.reason).toBeTruthy();
    });

    it(
      'produces a schema-valid object',
      async () => {
        const provider = options.provider();
        const result = await generateObject(provider, ContractSchema, {
          taskTag: 'contract',
          messages: [
            {
              role: 'user',
              content:
                'Return an object for a slideshow called "A life in three parts" with ' +
                '42 slides, snapped to the beat: title, slideCount, beatSnapped.',
            },
          ],
        });
        expect(ContractSchema.safeParse(result.object).success).toBe(true);
        expect(result.attempts).toBeGreaterThanOrEqual(1);
      },
      timeout,
    );

    if (options.repairPrompt) {
      const prompt = options.repairPrompt;
      it(
        'recovers through the repair loop when the first answer is broken',
        async () => {
          const result = await generateObject(options.provider(), ContractSchema, {
            taskTag: options.fixtureTaskTag ?? 'contract',
            messages: [{ role: 'user', content: prompt }],
          });
          expect(result.attempts).toBeGreaterThan(1);
          expect(ContractSchema.safeParse(result.object).success).toBe(true);
        },
        timeout,
      );
    }

    if (options.unfixablePrompt) {
      const prompt = options.unfixablePrompt;
      it(
        'gives up with a typed error rather than looping forever',
        async () => {
          await expect(
            generateObject(options.provider(), ContractSchema, {
              taskTag: options.fixtureTaskTag ?? 'contract',
              messages: [{ role: 'user', content: prompt }],
            }),
          ).rejects.toMatchObject({ name: 'AiSchemaError' });
        },
        timeout,
      );
    }

    it(
      'looks at an image when it says it can',
      async () => {
        const provider = options.provider();
        if (!provider.capabilities.vision || !options.fixturePhoto) return;
        const result = await provider.complete({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'In five words or fewer, what is in this image?' },
                { type: 'image', source: 'path', path: options.fixturePhoto },
              ],
            },
          ],
          taskTag: 'contract',
        });
        expect(result.text.trim().length).toBeGreaterThan(0);
      },
      timeout,
    );

    it(
      'carries a session id when it says it has sessions',
      async () => {
        const provider = options.provider();
        if (!provider.capabilities.nativeSessions) return;
        const first = await provider.complete({
          messages: [{ role: 'user', content: 'Remember the word "lantern". Reply with: ok' }],
          taskTag: 'contract',
        });
        expect(first.sessionId).toBeTruthy();
        const second = await provider.complete({
          messages: [{ role: 'user', content: 'What word did I ask you to remember?' }],
          sessionId: first.sessionId as string,
          taskTag: 'contract',
        });
        expect(second.text.trim().length).toBeGreaterThan(0);
      },
      timeout,
    );
  });
}

/** Adapters to exercise for real, and only when explicitly asked. */
export const LIVE_PROVIDER_IDS = [
  'claude-cli',
  'codex-cli',
  'anthropic-api',
  'openai-api',
] as const;

export function liveTestingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['AI_LIVE_TEST'] === '1';
}

/**
 * Which live adapters to run. `AI_LIVE_TEST_PROVIDERS` narrows it; otherwise
 * every adapter that reports itself as available gets a turn.
 */
export function liveProviderIds(env: Record<string, string | undefined> = process.env): string[] {
  const configured = env['AI_LIVE_TEST_PROVIDERS']?.trim();
  if (configured)
    return configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [...LIVE_PROVIDER_IDS];
}
