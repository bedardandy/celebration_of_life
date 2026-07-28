import { describe, expect, it } from 'vitest';
import {
  AiCapabilityError,
  AiProviderNotFoundError,
  ECHO_PREFIX,
  MOCK_PROVIDER_ID,
  getProvider,
  imagePathPart,
  listProviderIds,
  providerIdForTask,
  requireCapabilities,
  resolveProvider,
  textPart,
} from './index';

describe('provider registry', () => {
  it('registers the mock provider on import', () => {
    expect(listProviderIds()).toContain(MOCK_PROVIDER_ID);
    expect(getProvider(MOCK_PROVIDER_ID).capabilities.costTier).toBe('free');
  });

  it('names the available providers when one is missing', () => {
    expect(() => getProvider('gpt-9000')).toThrow(AiProviderNotFoundError);
    expect(() => getProvider('gpt-9000')).toThrow(/Available: mock/);
  });
});

describe('mock provider', () => {
  it('echoes the last user message', async () => {
    const provider = getProvider(MOCK_PROVIDER_ID);
    const result = await provider.complete({
      messages: [
        { role: 'system', content: 'You help families tell a life story.' },
        { role: 'user', content: 'Tell me about the garden.' },
        { role: 'assistant', content: 'Which garden?' },
        { role: 'user', content: 'The one behind the blue house.' },
      ],
    });
    expect(result.text).toBe(`${ECHO_PREFIX}The one behind the blue house.`);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('echoes multi-part content, including image placeholders', async () => {
    const result = await getProvider(MOCK_PROVIDER_ID).complete({
      messages: [
        {
          role: 'user',
          content: [textPart('What is in this photo?'), imagePathPart('/photos/01.jpg')],
        },
      ],
    });
    expect(result.text).toBe(`${ECHO_PREFIX}What is in this photo?\n[image: /photos/01.jpg]`);
  });

  it('echoes the session id back when one is supplied', async () => {
    const result = await getProvider(MOCK_PROVIDER_ID).complete({
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 'session-1',
    });
    expect(result.sessionId).toBe('session-1');
  });

  it('copes with a request that has no user message', async () => {
    const result = await getProvider(MOCK_PROVIDER_ID).complete({
      messages: [{ role: 'system', content: 'be kind' }],
    });
    expect(result.text).toBe(`${ECHO_PREFIX}(no user message)`);
  });
});

describe('resolveProvider', () => {
  it('defaults to the mock when nothing is configured', () => {
    expect(providerIdForTask('default', {})).toBe(MOCK_PROVIDER_ID);
    expect(resolveProvider('default', {}).id).toBe(MOCK_PROVIDER_ID);
  });

  it('honours the global provider, then per-task overrides', () => {
    const env = { AI_PROVIDER: 'claude-cli', AI_PROVIDER_VISION: 'openai-api' };
    expect(providerIdForTask('default', env)).toBe('claude-cli');
    expect(providerIdForTask('interview', env)).toBe('claude-cli');
    expect(providerIdForTask('vision', env)).toBe('openai-api');
  });

  it('forces the mock in NODE_ENV=test, whatever the shell says', () => {
    const env = { NODE_ENV: 'test', AI_PROVIDER: 'anthropic-api', AI_PROVIDER_VISION: 'codex-cli' };
    expect(providerIdForTask('default', env)).toBe(MOCK_PROVIDER_ID);
    expect(providerIdForTask('vision', env)).toBe(MOCK_PROVIDER_ID);
    // …and this test run is itself NODE_ENV=test, so the ambient call agrees.
    expect(resolveProvider().id).toBe(MOCK_PROVIDER_ID);
  });

  it('treats a blank AI_PROVIDER as unset', () => {
    expect(providerIdForTask('default', { AI_PROVIDER: '   ' })).toBe(MOCK_PROVIDER_ID);
  });
});

describe('requireCapabilities', () => {
  it('passes for capabilities the provider has', () => {
    expect(() =>
      requireCapabilities(getProvider(MOCK_PROVIDER_ID), { vision: true }),
    ).not.toThrow();
  });

  it('fails fast, naming what is missing', () => {
    expect(() =>
      requireCapabilities(getProvider(MOCK_PROVIDER_ID), { nativeJsonSchema: true }),
    ).toThrow(AiCapabilityError);
  });
});
