import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiSchemaError,
  DEFAULT_MAX_REPAIRS,
  REPAIR_MARKER,
  SCHEMA_INSTRUCTION_MARKER,
  appendSchemaInstruction,
  friendlyAiMessage,
  generateObject,
  requestMatchText,
  stripSchemaInstruction,
} from './generate-object';
import { getProvider, MOCK_PROVIDER_ID, resetMockState } from './index';
import type { AiCompleteRequest, AiCompleteResult, AiProvider } from './types';

const ToySchema = z
  .object({
    title: z.string().min(1),
    slideCount: z.number().int().min(0),
    beatSnapped: z.boolean(),
  })
  .strict();

/** A provider that reads from a script. Nothing here touches the fixture files. */
function scripted(
  responses: string[],
  overrides: Partial<AiProvider> = {},
): AiProvider & { seen: AiCompleteRequest[] } {
  const seen: AiCompleteRequest[] = [];
  let i = 0;
  return {
    id: 'scripted',
    capabilities: {
      text: true,
      nativeJsonSchema: false,
      vision: false,
      visionInput: 'none',
      nativeSessions: false,
      maxImagesPerCall: 0,
      costTier: 'free',
    },
    ...overrides,
    seen,
    async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
      seen.push(request);
      const text = responses[Math.min(i, responses.length - 1)] as string;
      i += 1;
      return { text };
    },
  } as AiProvider & { seen: AiCompleteRequest[] };
}

beforeEach(() => {
  resetMockState();
});

describe('appendSchemaInstruction', () => {
  it('appends to the last user message rather than adding a turn', () => {
    const messages = appendSchemaInstruction(
      [
        { role: 'system', content: 'be kind' },
        { role: 'user', content: 'tell me about the garden' },
        { role: 'assistant', content: 'which garden?' },
      ],
      { type: 'object' },
    );
    expect(messages).toHaveLength(3);
    expect(messages[2]?.role).toBe('assistant');
    expect(JSON.stringify(messages[1]?.content)).toContain('Respond with ONLY a JSON object');
  });

  it('adds a user turn when there is nowhere to append', () => {
    const messages = appendSchemaInstruction([{ role: 'system', content: 'be kind' }], {});
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe('user');
  });
});

describe('requestMatchText', () => {
  it('strips the schema block so fixture keys survive a schema change', () => {
    const text = `the dahlias${SCHEMA_INSTRUCTION_MARKER}{"type":"object"}`;
    expect(stripSchemaInstruction(text)).toBe('the dahlias');
  });

  it('skips repair turns and returns the real question', () => {
    const text = requestMatchText([
      { role: 'user', content: 'the dahlias' },
      { role: 'assistant', content: '{broken' },
      { role: 'user', content: `${REPAIR_MARKER} fix it` },
    ]);
    expect(text).toBe('the dahlias');
  });
});

describe('generateObject', () => {
  it('validates a clean first answer without repairing', async () => {
    const provider = scripted(['{"title":"A life","slideCount":42,"beatSnapped":true}']);
    const result = await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(result.object.title).toBe('A life');
    expect(result.attempts).toBe(1);
    expect(result.salvaged).toBe(false);
  });

  it('puts the schema in the prompt when the provider has no native support', async () => {
    const provider = scripted(['{"title":"x","slideCount":1,"beatSnapped":false}']);
    await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    const flattened = JSON.stringify(provider.seen[0]?.messages);
    expect(flattened).toContain('Respond with ONLY a JSON object');
    // …and it still travels on the request, for adapters and the mock.
    expect(provider.seen[0]?.jsonSchema).toBeTruthy();
  });

  it('leaves the prompt alone when the provider takes a schema natively', async () => {
    const provider = scripted(['{"title":"x","slideCount":1,"beatSnapped":false}'], {
      capabilities: {
        text: true,
        nativeJsonSchema: true,
        vision: false,
        visionInput: 'none',
        nativeSessions: false,
        maxImagesPerCall: 0,
        costTier: 'free',
      },
    });
    await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(JSON.stringify(provider.seen[0]?.messages)).not.toContain('Respond with ONLY');
    expect(provider.seen[0]?.jsonSchema).toBeTruthy();
  });

  it('salvages JSON out of prose and a code fence', async () => {
    const provider = scripted([
      'Sure!\n```json\n{"title":"A life","slideCount":42,"beatSnapped":true}\n```\nHope that helps.',
    ]);
    const result = await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(result.salvaged).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('repairs a broken answer and reports the extra attempt', async () => {
    const provider = scripted([
      '{"title":"A life","slideCount":',
      '{"title":"A life","slideCount":42,"beatSnapped":true}',
    ]);
    const result = await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(result.attempts).toBe(2);
    expect(result.object.slideCount).toBe(42);

    // The repair turn names the problem and carries the offending output back.
    const repair = JSON.stringify(provider.seen[1]?.messages);
    expect(repair).toContain(REPAIR_MARKER);
    expect(repair).toContain('Fix and return only corrected JSON');
  });

  it('repairs a schema violation, not just bad syntax', async () => {
    const provider = scripted([
      '{"title":"A life","slideCount":"lots","beatSnapped":true}',
      '{"title":"A life","slideCount":42,"beatSnapped":true}',
    ]);
    const result = await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(result.attempts).toBe(2);
    expect(JSON.stringify(provider.seen[1]?.messages)).toContain('slideCount');
  });

  it('gives up after the repair budget and throws a typed error', async () => {
    const provider = scripted(['I would rather not answer that.']);
    await expect(
      generateObject(provider, ToySchema, {
        taskTag: 'edl',
        messages: [{ role: 'user', content: 'shape the story' }],
      }),
    ).rejects.toBeInstanceOf(AiSchemaError);

    try {
      await generateObject(provider, ToySchema, {
        taskTag: 'edl',
        messages: [{ role: 'user', content: 'shape the story' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const schemaError = error as AiSchemaError;
      expect(schemaError.attempts).toBe(DEFAULT_MAX_REPAIRS + 1);
      expect(schemaError.lastRaw).toContain('I would rather not');
      expect(schemaError.taskTag).toBe('edl');
      expect(schemaError.issues.length).toBeGreaterThan(0);
    }
  });

  it('honours a smaller repair budget', async () => {
    const provider = scripted(['nope']);
    try {
      await generateObject(provider, ToySchema, {
        taskTag: 'edl',
        maxRepairs: 0,
        messages: [{ role: 'user', content: 'shape the story' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AiSchemaError).attempts).toBe(1);
    }
  });

  it('carries a provider session id forward', async () => {
    const provider = scripted(['{"title":"x","slideCount":0,"beatSnapped":false}'], {
      capabilities: {
        text: true,
        nativeJsonSchema: false,
        vision: false,
        visionInput: 'none',
        nativeSessions: true,
        maxImagesPerCall: 0,
        costTier: 'subscription',
      },
    });
    const result = await generateObject(provider, ToySchema, {
      taskTag: 'edl',
      sessionId: 'session-7',
      messages: [{ role: 'user', content: 'shape the story' }],
    });
    expect(provider.seen[0]?.sessionId).toBe('session-7');
    expect(result.sessionId).toBe('session-7');
  });
});

describe('generateObject against the mock provider and real fixtures', () => {
  it('salvages the committed malformed-json fixture', async () => {
    const result = await generateObject(getProvider(MOCK_PROVIDER_ID), ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'give me the malformed case' }],
    });
    expect(result.object.slideCount).toBe(42);
    expect(result.salvaged).toBe(true);
  });

  it('walks the broken-once fixture through exactly one repair', async () => {
    const result = await generateObject(getProvider(MOCK_PROVIDER_ID), ToySchema, {
      taskTag: 'edl',
      messages: [{ role: 'user', content: 'give me the broken once case' }],
    });
    expect(result.attempts).toBe(2);
    expect(result.object).toEqual({
      title: 'A life in three parts',
      slideCount: 42,
      beatSnapped: true,
    });
  });

  it('surfaces AiSchemaError for the unfixable fixture', async () => {
    await expect(
      generateObject(getProvider(MOCK_PROVIDER_ID), ToySchema, {
        taskTag: 'edl',
        messages: [{ role: 'user', content: 'give me the unfixable case' }],
      }),
    ).rejects.toBeInstanceOf(AiSchemaError);
  });

  it('synthesises a valid object when no fixture matches', async () => {
    const result = await generateObject(getProvider(MOCK_PROVIDER_ID), ToySchema, {
      taskTag: 'nothing-here',
      messages: [{ role: 'user', content: 'a request nobody has written a fixture for' }],
    });
    expect(ToySchema.safeParse(result.object).success).toBe(true);
  });
});

describe('friendlyAiMessage', () => {
  it('never leaks the technical detail, and always says nothing was lost', () => {
    const error = new AiSchemaError('interview', 'mock', 3, '{oops', ['title: required']);
    const message = friendlyAiMessage(error);
    expect(message).not.toContain('title');
    expect(message).not.toContain('mock');
    expect(message).toMatch(/nothing you wrote was lost/i);
  });

  it('has something calm to say about an error it has never seen', () => {
    expect(friendlyAiMessage(new Error('ECONNRESET'))).toMatch(/nothing you wrote was lost/i);
  });
});
