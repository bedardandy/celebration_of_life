import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiCapabilityError,
  AiProviderNotFoundError,
  AiProviderUnavailableError,
  MOCK_PROVIDER_ID,
  capableProviders,
  checkClaudeCli,
  checkCodexCli,
  checkOpenaiApi,
  decidingEnvVar,
  ignoredTestProviders,
  normalizeTask,
  providerIdForTask,
  registerProvider,
  resetResolveWarnings,
  resolveProvider,
  taskEnvVar,
} from './index';
import { setCodexImageSupport } from './providers/codex-cli';
import type { AiProvider, CheckableProvider } from './types';

/** A provider with whatever capabilities a test needs to talk about. */
function fake(id: string, overrides: Partial<AiProvider['capabilities']> = {}): AiProvider {
  return {
    id,
    capabilities: {
      text: true,
      nativeJsonSchema: false,
      vision: false,
      visionInput: 'none',
      nativeSessions: false,
      maxImagesPerCall: 0,
      costTier: 'free',
      ...overrides,
    },
    async complete() {
      return { text: '' };
    },
  };
}

beforeEach(() => {
  resetResolveWarnings();
  setCodexImageSupport(undefined);
});
afterEach(() => {
  setCodexImageSupport(undefined);
});

describe('task naming', () => {
  it('maps the names callers use onto the env vars people type', () => {
    expect(normalizeTask('photo-analysis')).toBe('vision');
    expect(normalizeTask('edl-generation')).toBe('edl');
    expect(normalizeTask('copy-drafting')).toBe('caption');
    expect(taskEnvVar('vision')).toBe('AI_PROVIDER_VISION');
    expect(taskEnvVar('interview')).toBe('AI_PROVIDER_INTERVIEW');
  });

  it('routes a task-named lookup through the right override', () => {
    const env = { AI_PROVIDER: 'claude-cli', AI_PROVIDER_VISION: 'openai-api' };
    expect(providerIdForTask('photo-analysis', env)).toBe('openai-api');
    expect(providerIdForTask('edl-generation', env)).toBe('claude-cli');
  });

  it('names the env var that actually decided, for the error message', () => {
    expect(decidingEnvVar('photo-analysis', { AI_PROVIDER_VISION: 'x' })).toBe(
      'AI_PROVIDER_VISION',
    );
    expect(decidingEnvVar('photo-analysis', { AI_PROVIDER: 'x' })).toBe('AI_PROVIDER');
  });
});

describe('resolveProvider capability checks', () => {
  it('fails fast when a photo task gets a provider with no vision', () => {
    registerProvider(fake('sightless', { vision: false }));
    const env = { AI_PROVIDER_VISION: 'sightless' };

    expect(() => resolveProvider('photo-analysis', env)).toThrow(AiCapabilityError);
    try {
      resolveProvider('photo-analysis', env);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      // The message has to say which knob to turn, not just that something broke.
      expect(message).toContain('vision');
      expect(message).toContain('AI_PROVIDER_VISION');
      expect(message).toContain('photo-analysis');
      expect(message).toContain(MOCK_PROVIDER_ID);
    }
  });

  it('is the same failure when the codex probe reports no image support', () => {
    // This is the case the acceptance criteria names: a real adapter whose
    // capabilities are discovered rather than declared.
    setCodexImageSupport(false);
    expect(() => resolveProvider('photo-analysis', { AI_PROVIDER_VISION: 'codex-cli' })).toThrow(
      /vision.*AI_PROVIDER_VISION/s,
    );

    setCodexImageSupport(true);
    // Vision is satisfied now, so the next complaint is the missing binary —
    // which is the right next complaint.
    expect(() => resolveProvider('photo-analysis', { AI_PROVIDER_VISION: 'codex-cli' })).toThrow(
      AiProviderUnavailableError,
    );
  });

  it('passes a vision-capable provider straight through', () => {
    registerProvider(fake('seeing', { vision: true }));
    expect(resolveProvider('photo-analysis', { AI_PROVIDER_VISION: 'seeing' }).id).toBe('seeing');
  });

  it('names the providers that could do the job instead', () => {
    expect(capableProviders(['vision'])).toContain(MOCK_PROVIDER_ID);
    expect(capableProviders(['vision'])).not.toContain('sightless');
  });

  it('still complains by name about an id nobody registered', () => {
    expect(() => resolveProvider('interview', { AI_PROVIDER: 'gpt-9000' })).toThrow(
      AiProviderNotFoundError,
    );
  });
});

describe('resolveProvider availability checks', () => {
  it('refuses a provider that is configured but cannot run, and says what to do', () => {
    const unavailable: CheckableProvider = {
      ...fake('needs-a-key'),
      checkAvailability: () => ({
        ok: false,
        reason: 'EXAMPLE_API_KEY is not set',
        remedy: 'Put your key in .env as EXAMPLE_API_KEY.',
      }),
    };
    registerProvider(unavailable);

    try {
      resolveProvider('interview', { AI_PROVIDER: 'needs-a-key' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderUnavailableError);
      const message = (error as Error).message;
      expect(message).toContain('EXAMPLE_API_KEY is not set');
      expect(message).toContain('Put your key in .env');
      expect(message).toContain('AI_PROVIDER');
    }
  });

  it('refuses the API adapters when their key is missing, without a network call', () => {
    for (const id of ['anthropic-api', 'openai-api']) {
      expect(() => resolveProvider('interview', { AI_PROVIDER: id })).toThrow(
        AiProviderUnavailableError,
      );
    }
  });

  it('accepts openai-api without a key when a local base URL is configured', () => {
    // Ollama and friends need no key; pointing OPENAI_BASE_URL at one is
    // consent to run without.
    expect(checkOpenaiApi({ OPENAI_BASE_URL: 'http://localhost:11434' }).ok).toBe(true);
  });

  it('reports a missing CLI binary by name, with a remedy', () => {
    // `claude` happens to be installed in some development environments, so
    // this points both checks at a path that certainly is not.
    const missing = {
      CLAUDE_CLI_PATH: 'claude-not-installed',
      CODEX_CLI_PATH: 'codex-not-installed',
    };
    for (const check of [checkClaudeCli, checkCodexCli]) {
      const result = check(missing);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not on PATH/);
      expect(result.remedy).toBeTruthy();
    }
  });
});

describe('the test environment', () => {
  it('forces the mock and reports what it ignored', () => {
    const env = { NODE_ENV: 'test', AI_PROVIDER: 'anthropic-api', AI_PROVIDER_VISION: 'codex-cli' };
    expect(providerIdForTask('interview', env)).toBe(MOCK_PROVIDER_ID);
    expect(resolveProvider('photo-analysis', env).id).toBe(MOCK_PROVIDER_ID);
    expect(ignoredTestProviders(env)).toEqual(['AI_PROVIDER', 'AI_PROVIDER_VISION']);
  });

  it('has nothing to report when the shell is already set to the mock', () => {
    expect(ignoredTestProviders({ NODE_ENV: 'test', AI_PROVIDER: 'mock' })).toEqual([]);
  });
});
