/**
 * OpenAI-compatible chat completions, over plain `fetch`.
 *
 * `OPENAI_BASE_URL` is honoured, which is the whole reason this adapter is
 * worth having twice over: the same code reaches OpenAI, Ollama, vLLM,
 * LM Studio or any of the other servers that speak this shape. A family that
 * wants nothing leaving their laptop points this at localhost and everything
 * else in the product is unchanged.
 */
import {
  AiCallError,
  AiProviderUnavailableError,
  contentParts,
  type AiAvailability,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiMessage,
  type CheckableProvider,
} from '../types';
import { fetchJson } from './anthropic-api';
import { readImagePart } from './image-data';

export const OPENAI_PROVIDER_ID = 'openai-api';
export const DEFAULT_OPENAI_MODEL = 'gpt-5';

export function openaiModel(env: Record<string, string | undefined> = process.env): string {
  return env['AI_MODEL_OPENAI']?.trim() || DEFAULT_OPENAI_MODEL;
}

export function openaiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env['OPENAI_BASE_URL']?.trim() || 'https://api.openai.com').replace(/\/+$/, '');
}

/**
 * Local servers usually need no key at all, so a custom base URL is treated as
 * consent to run without one. Pointing at api.openai.com without a key is a
 * misconfiguration worth naming.
 */
export function checkOpenaiApi(
  env: Record<string, string | undefined> = process.env,
): AiAvailability {
  if (env['OPENAI_API_KEY']?.trim()) return { ok: true };
  if (env['OPENAI_BASE_URL']?.trim()) {
    return { ok: true, reason: 'no API key set; assuming the custom OPENAI_BASE_URL needs none' };
  }
  return {
    ok: false,
    reason: 'OPENAI_API_KEY is not set',
    remedy:
      'Put your key in .env as OPENAI_API_KEY, or set OPENAI_BASE_URL to a local ' +
      'OpenAI-compatible server (Ollama, vLLM, LM Studio).',
  };
}

/**
 * `response_format: json_schema` is not universal across compatible servers, so
 * it is opt-in. Off means the schema travels in the prompt, which always works.
 */
export function openaiSupportsJsonSchema(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env['OPENAI_JSON_SCHEMA']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/* -------------------------------------------------------------------------- */

type OpenAiContent =
  string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

export type OpenAiRequestBody = {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: OpenAiContent }[];
  max_completion_tokens?: number;
  temperature?: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
};

export async function buildOpenAiBody(
  request: AiCompleteRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<OpenAiRequestBody> {
  const messages: OpenAiRequestBody['messages'] = [];
  for (const message of request.messages) {
    const content = await toContent(message);
    if (Array.isArray(content) && content.length === 0) continue;
    messages.push({ role: message.role, content });
  }
  if (messages.length === 0) messages.push({ role: 'user', content: '(no message)' });

  const body: OpenAiRequestBody = { model: openaiModel(env), messages };
  if (request.maxTokens !== undefined) body.max_completion_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonSchema && openaiSupportsJsonSchema(env)) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: stripMeta(request.jsonSchema) },
    };
  }
  return body;
}

function stripMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

async function toContent(message: AiMessage): Promise<OpenAiContent> {
  const parts = contentParts(message);
  if (parts.every((p) => p.type === 'text')) {
    return parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .trim();
  }
  const out: Exclude<OpenAiContent, string> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) out.push({ type: 'text', text: part.text });
      continue;
    }
    const image = await readImagePart(part);
    out.push({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */

export type OpenAiResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

export function extractOpenAiText(body: OpenAiResponse): string {
  return (body.choices?.[0]?.message?.content ?? '').trim();
}

export const openaiApiProvider: CheckableProvider = {
  id: OPENAI_PROVIDER_ID,
  get capabilities() {
    return {
      text: true as const,
      nativeJsonSchema: openaiSupportsJsonSchema(),
      vision: true,
      visionInput: 'base64' as const,
      nativeSessions: false,
      maxImagesPerCall: 10,
      costTier: 'metered' as const,
    };
  },
  checkAvailability: checkOpenaiApi,
  async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
    const availability = checkOpenaiApi();
    if (!availability.ok) {
      throw new AiProviderUnavailableError(
        OPENAI_PROVIDER_ID,
        availability.reason ?? 'unavailable',
        availability.remedy,
      );
    }

    const started = Date.now();
    const body = await buildOpenAiBody(request);
    const timeoutMs = Number.parseInt(process.env['AI_HTTP_TIMEOUT_MS'] ?? '', 10) || 120_000;
    const key = process.env['OPENAI_API_KEY']?.trim();

    const response = (await fetchJson(
      `${openaiBaseUrl()}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
      OPENAI_PROVIDER_ID,
    )) as OpenAiResponse;

    if (response.error) {
      throw new AiCallError(OPENAI_PROVIDER_ID, response.error.message ?? 'request failed');
    }
    const text = extractOpenAiText(response);
    if (text.length === 0) throw new AiCallError(OPENAI_PROVIDER_ID, 'returned an empty message');

    return {
      text,
      usage: {
        ...(response.usage?.prompt_tokens === undefined
          ? {}
          : { inputTokens: response.usage.prompt_tokens }),
        ...(response.usage?.completion_tokens === undefined
          ? {}
          : { outputTokens: response.usage.completion_tokens }),
        durationMs: Date.now() - started,
      },
      raw: response,
    };
  },
};
