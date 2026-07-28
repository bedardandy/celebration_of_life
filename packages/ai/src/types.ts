/**
 * The provider seam.
 *
 * The product must never depend on one vendor: dev is driven by the user's
 * Claude Code / Codex subscriptions, CI by a deterministic mock, and production
 * by whichever API key exists. Everything above this file talks in these types
 * only, so adding an adapter is additive.
 *
 * Phase 0 ships the shape plus the mock. The five real adapters, the
 * `generateObject` repair loop and `pnpm ai:doctor` land in Phase 3.
 */

/**
 * What an adapter can actually do. Declared up front so a capability mismatch
 * (e.g. asking a text-only provider to look at photos) fails fast at boot
 * instead of halfway through a grieving family's evening.
 */
export type AiCapabilities = {
  /** Every provider does text. Present so capability checks read uniformly. */
  text: true;
  /** Provider accepts a JSON Schema and guarantees conforming output. */
  nativeJsonSchema: boolean;
  vision: boolean;
  /** How images must be handed over. 'none' whenever `vision` is false. */
  visionInput: 'file-path' | 'base64' | 'none';
  /** Provider keeps its own conversation state (an optimisation, never a requirement). */
  nativeSessions: boolean;
  maxImagesPerCall: number;
  /**
   * subscription = covered by a flat-rate CLI login (claude/codex)
   * metered      = billed per token
   * free         = local model or the mock
   */
  costTier: 'subscription' | 'metered' | 'free';
};

export type TextPart = { type: 'text'; text: string };

/** Images travel either as a path on disk (CLI adapters) or inline base64. */
export type ImagePart =
  | { type: 'image'; source: 'path'; path: string; mime?: string }
  | { type: 'image'; source: 'base64'; base64: string; mime: string };

export type ContentPart = TextPart | ImagePart;

export type AiRole = 'system' | 'user' | 'assistant';

export type AiMessage = {
  role: AiRole;
  /** A bare string is sugar for a single text part. */
  content: string | ContentPart[];
};

export type AiCompleteRequest = {
  messages: AiMessage[];
  /** Resume a provider-side conversation, when the provider has them. */
  sessionId?: string;
  /** JSON Schema (usually `z.toJSONSchema(someZodSchema)`) for structured output. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
};

export type AiUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Wall-clock time for the call, useful for the doctor command. */
  durationMs?: number;
};

export type AiCompleteResult = {
  text: string;
  /** Echoed/created session id, when the provider supports sessions. */
  sessionId?: string;
  usage?: AiUsage;
  /** Untouched provider response, for debugging. Never parsed by callers. */
  raw?: unknown;
};

export interface AiProvider {
  readonly id: string;
  readonly capabilities: AiCapabilities;
  complete(request: AiCompleteRequest): Promise<AiCompleteResult>;
}

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiError';
  }
}

export class AiProviderNotFoundError extends AiError {
  constructor(
    readonly requested: string,
    readonly known: readonly string[],
  ) {
    super(
      `Unknown AI provider "${requested}". Available: ${known.length ? known.join(', ') : '(none registered)'}.`,
    );
    this.name = 'AiProviderNotFoundError';
  }
}

export class AiCapabilityError extends AiError {
  constructor(
    readonly providerId: string,
    readonly missing: readonly string[],
  ) {
    super(`AI provider "${providerId}" cannot do: ${missing.join(', ')}.`);
    this.name = 'AiCapabilityError';
  }
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function textPart(text: string): TextPart {
  return { type: 'text', text };
}

export function imagePathPart(path: string, mime?: string): ImagePart {
  return mime === undefined
    ? { type: 'image', source: 'path', path }
    : { type: 'image', source: 'path', path, mime };
}

export function imageBase64Part(base64: string, mime: string): ImagePart {
  return { type: 'image', source: 'base64', base64, mime };
}

/** Normalise `content` to parts so adapters never branch on the sugar form. */
export function contentParts(message: AiMessage): ContentPart[] {
  return typeof message.content === 'string' ? [textPart(message.content)] : message.content;
}

/** Flatten a message to plain text; images become a stable placeholder. */
export function messageText(message: AiMessage): string {
  return contentParts(message)
    .map((part) =>
      part.type === 'text'
        ? part.text
        : part.source === 'path'
          ? `[image: ${part.path}]`
          : `[image: ${part.base64.length} base64 bytes]`,
    )
    .join('\n');
}

export function countImages(messages: readonly AiMessage[]): number {
  let n = 0;
  for (const message of messages) {
    for (const part of contentParts(message)) if (part.type === 'image') n += 1;
  }
  return n;
}

/**
 * Fail fast on a provider that cannot do what a task needs. Phase 3 calls this
 * at boot; it lives here so adapters and callers agree on the wording.
 */
export function requireCapabilities(
  provider: AiProvider,
  required: Partial<Pick<AiCapabilities, 'vision' | 'nativeJsonSchema' | 'nativeSessions'>>,
): void {
  const missing: string[] = [];
  for (const key of ['vision', 'nativeJsonSchema', 'nativeSessions'] as const) {
    if (required[key] === true && provider.capabilities[key] !== true) missing.push(key);
  }
  if (missing.length > 0) throw new AiCapabilityError(provider.id, missing);
}
