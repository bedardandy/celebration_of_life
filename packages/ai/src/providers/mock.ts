import {
  contentParts,
  countImages,
  messageText,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiMessage,
  type AiProvider,
} from '../types';

export const MOCK_PROVIDER_ID = 'mock';

/**
 * The deterministic provider. CI never touches a real model, so this is the one
 * that every automated test runs against.
 *
 * Phase 0 behaviour is deliberately trivial: echo the last user message. Phase 3
 * layers canned fixture responses (fixtures/ai/**) on top of the same id, so
 * tests written now keep working.
 */
export const ECHO_PREFIX = 'echo: ';

function lastUserMessage(messages: readonly AiMessage[]): AiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

export function mockResponseText(request: AiCompleteRequest): string {
  const message = lastUserMessage(request.messages);
  if (!message) return `${ECHO_PREFIX}(no user message)`;
  return `${ECHO_PREFIX}${messageText(message)}`;
}

export const mockProvider: AiProvider = {
  id: MOCK_PROVIDER_ID,
  capabilities: {
    text: true,
    // Structured output goes through the schema-in-prompt path, which is the
    // path most real adapters use — better to exercise that one in CI.
    nativeJsonSchema: false,
    vision: true,
    visionInput: 'file-path',
    nativeSessions: false,
    maxImagesPerCall: 8,
    costTier: 'free',
  },
  async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
    const text = mockResponseText(request);
    const inputTokens = request.messages.reduce(
      (n, m) =>
        n + contentParts(m).reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0),
      0,
    );
    return {
      text,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      usage: { inputTokens, outputTokens: text.length, durationMs: 0 },
      raw: { provider: MOCK_PROVIDER_ID, images: countImages(request.messages) },
    };
  },
};
