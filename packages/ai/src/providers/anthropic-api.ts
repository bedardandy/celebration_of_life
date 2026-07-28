/**
 * Anthropic's Messages API, over plain `fetch`.
 *
 * No SDK on purpose. The dependency surface of this repo is a thing families
 * never see and maintainers always pay for, and this endpoint is three fields
 * and a POST. `fetch` is in Node 22.
 *
 * Structured output goes through forced tool use: one tool called `emit` whose
 * input schema is the schema we want back. It is the only way to get a
 * guaranteed-shaped object out of this API, and it is why this adapter can
 * declare `nativeJsonSchema: true` when the caller supplies one.
 */
import {
  AiCallError,
  AiProviderUnavailableError,
  AiTimeoutError,
  contentParts,
  type AiAvailability,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiMessage,
  type CheckableProvider,
  type ContentPart,
} from '../types';
import { readImagePart } from './image-data';

export const ANTHROPIC_PROVIDER_ID = 'anthropic-api';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const EMIT_TOOL_NAME = 'emit';

export function anthropicModel(env: Record<string, string | undefined> = process.env): string {
  return env['AI_MODEL_ANTHROPIC']?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

export function anthropicBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env['ANTHROPIC_BASE_URL']?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
}

export function checkAnthropicApi(
  env: Record<string, string | undefined> = process.env,
): AiAvailability {
  if (env['ANTHROPIC_API_KEY']?.trim()) return { ok: true };
  return {
    ok: false,
    reason: 'ANTHROPIC_API_KEY is not set',
    remedy: 'Put your key in .env as ANTHROPIC_API_KEY, or use AI_PROVIDER=claude-cli instead.',
  };
}

/* -------------------------------------------------------------------------- */
/* request shaping                                                             */
/* -------------------------------------------------------------------------- */

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[];
  temperature?: number;
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  tool_choice?: { type: 'tool'; name: string };
};

export async function buildAnthropicBody(
  request: AiCompleteRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<AnthropicRequestBody> {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m))
    .filter((t) => t.length > 0)
    .join('\n\n');

  const messages: AnthropicRequestBody['messages'] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    const blocks = await toBlocks(message);
    if (blocks.length === 0) continue;
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: '(no message)' }] });
  }

  const body: AnthropicRequestBody = {
    model: anthropicModel(env),
    max_tokens: request.maxTokens ?? 4096,
    messages,
  };
  if (system.length > 0) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonSchema) {
    body.tools = [
      {
        name: EMIT_TOOL_NAME,
        description: 'Return the requested structured result. Call this exactly once.',
        input_schema: normalizeSchema(request.jsonSchema),
      },
    ];
    body.tool_choice = { type: 'tool', name: EMIT_TOOL_NAME };
  }
  return body;
}

/** The API rejects `$schema`; everything else passes through unchanged. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return { type: 'object', ...rest };
}

function textOf(message: AiMessage): string {
  return contentParts(message)
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

async function toBlocks(message: AiMessage): Promise<AnthropicBlock[]> {
  const blocks: AnthropicBlock[] = [];
  for (const part of contentParts(message)) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const image = await readImagePart(part);
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mime, data: image.base64 },
    });
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* response                                                                    */
/* -------------------------------------------------------------------------- */

export type AnthropicResponse = {
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
};

/** Tool input wins when present; otherwise the concatenated text blocks. */
export function extractAnthropicText(body: AnthropicResponse): string {
  const blocks = body.content ?? [];
  const tool = blocks.find((b) => b.type === 'tool_use' && b.name === EMIT_TOOL_NAME);
  if (tool && tool.input !== undefined) return JSON.stringify(tool.input);
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

/* -------------------------------------------------------------------------- */

export const anthropicApiProvider: CheckableProvider = {
  id: ANTHROPIC_PROVIDER_ID,
  capabilities: {
    text: true,
    nativeJsonSchema: true,
    vision: true,
    visionInput: 'base64',
    nativeSessions: false,
    maxImagesPerCall: 20,
    costTier: 'metered',
  },
  checkAvailability: checkAnthropicApi,
  async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
    const availability = checkAnthropicApi();
    if (!availability.ok) {
      throw new AiProviderUnavailableError(
        ANTHROPIC_PROVIDER_ID,
        availability.reason ?? 'unavailable',
        availability.remedy,
      );
    }

    const started = Date.now();
    const body = await buildAnthropicBody(request);
    const timeoutMs = Number.parseInt(process.env['AI_HTTP_TIMEOUT_MS'] ?? '', 10) || 120_000;

    const response = await fetchJson(
      `${anthropicBaseUrl()}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env['ANTHROPIC_API_KEY'] as string,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
      ANTHROPIC_PROVIDER_ID,
    );

    const parsed = response as AnthropicResponse;
    if (parsed.error) {
      throw new AiCallError(ANTHROPIC_PROVIDER_ID, parsed.error.message ?? 'request failed');
    }
    const text = extractAnthropicText(parsed);
    if (text.length === 0)
      throw new AiCallError(ANTHROPIC_PROVIDER_ID, 'returned an empty message');

    return {
      text,
      usage: {
        ...(parsed.usage?.input_tokens === undefined
          ? {}
          : { inputTokens: parsed.usage.input_tokens }),
        ...(parsed.usage?.output_tokens === undefined
          ? {}
          : { outputTokens: parsed.usage.output_tokens }),
        durationMs: Date.now() - started,
      },
      raw: parsed,
    };
  },
};

/* -------------------------------------------------------------------------- */

/** Shared by both HTTP adapters: timeout, status check, JSON body, plain errors. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  providerId: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new AiTimeoutError(providerId, timeoutMs);
    throw new AiCallError(providerId, 'could not be reached', String(err));
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AiCallError(
      providerId,
      `HTTP ${response.status} ${response.statusText}`,
      text.slice(0, 400),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiCallError(providerId, 'returned a body that is not JSON', text.slice(0, 400));
  }
}
