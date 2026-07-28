/**
 * The deterministic provider. CI never touches a real model, so this is the one
 * that every automated test runs against.
 *
 * It answers in three ways, in order:
 *   1. a fixture from `fixtures/ai/<taskTag>/` — handwritten, warm, the thing
 *      the interview tests actually assert on
 *   2. a minimal object synthesised from the request's JSON Schema, so a new
 *      call site is testable before anyone writes a fixture for it
 *   3. an echo of the last user message, which is the Phase 0 behaviour and
 *      what plain `complete()` calls still get
 *
 * Nothing here consults a clock or a random number. A fixture that varies is a
 * flaky test wearing a disguise.
 */
import path from 'node:path';
import {
  contentParts,
  countImages,
  messageText,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiMessage,
  type AiProvider,
  type ContentPart,
} from '../types';
import { findFixture, fixtureResponseText, fixturesDir, type FixtureCase } from '../fixtures';
import { hasRepairTurn, requestMatchText } from '../generate-object';
import { parseAssetLines } from '../prompts/photo-analysis';
import { synthesizeFromJsonSchema } from '../schema-walker';

/** Task tag the photo-analysis batch job uses; also its fixture folder. */
export const PHOTO_ANALYSIS_TASK = 'photo-analysis';

export const MOCK_PROVIDER_ID = 'mock';

export const ECHO_PREFIX = 'echo: ';

/**
 * How many times each scripted fixture has been served. Module-level because
 * "broken once, then fixed" is a property of a run, not of a request — the
 * repair call has to see the second entry.
 */
const scriptCursor = new Map<string, number>();

/** Test hook. Call between tests so a scripted fixture starts over. */
export function resetMockState(): void {
  scriptCursor.clear();
}

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

/** Image file basenames referenced anywhere in the request. */
export function requestImageNames(messages: readonly AiMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const part of contentParts(message) as ContentPart[]) {
      if (part.type !== 'image') continue;
      names.push(part.source === 'path' ? path.basename(part.path) : `inline-${names.length}`);
    }
  }
  return names;
}

/** What a scripted fixture serves on its nth resolution. */
function scriptedResponse(fixture: FixtureCase, cursorKey: string): unknown {
  if (fixture.responses && fixture.responses.length > 0) {
    const seen = scriptCursor.get(cursorKey) ?? 0;
    scriptCursor.set(cursorKey, seen + 1);
    return fixture.responses[Math.min(seen, fixture.responses.length - 1)];
  }
  return fixture.response;
}

export type MockResolution = {
  text: string;
  source: 'fixture' | 'photo-batch' | 'schema' | 'echo';
  fixtureId?: string;
};

export function resolveMockResponse(
  request: AiCompleteRequest,
  dir = fixturesDir(),
): MockResolution {
  const task = request.taskTag ?? 'default';
  const matchText = requestMatchText(request.messages);
  const fixture = findFixture(task, matchText, dir);

  const batch = photoBatchResponse(request, matchText, dir);
  if (batch) return batch;

  if (fixture) {
    const value = scriptedResponse(fixture, `${dir}::${task}::${fixture.id}`);
    if (value !== undefined) {
      return { text: fixtureResponseText(value), source: 'fixture', fixtureId: fixture.id };
    }
  }

  if (request.jsonSchema) {
    // No fixture, but the caller wants an object: hand back the emptiest thing
    // the schema will accept. It is visibly a placeholder, which is the point.
    return {
      text: JSON.stringify(synthesizeFromJsonSchema(request.jsonSchema), null, 2),
      source: 'schema',
    };
  }

  // A repair turn with nothing to repair against would loop forever on an echo;
  // better to say so plainly.
  if (hasRepairTurn(request.messages)) {
    return { text: `${ECHO_PREFIX}(no fixture for the repair turn)`, source: 'echo' };
  }

  return { text: mockResponseText(request), source: 'echo' };
}

/**
 * Photo analysis is the one request shape the mock understands structurally.
 *
 * The batch job asks about N photographs at once and needs the answers tied
 * back to N asset ids that only exist at runtime, so a fixture cannot name
 * them. Instead the job writes `- <assetId> :: <path>` lines, and the mock
 * reads them back and keys each canned analysis by the file's basename. Job and
 * mock share `parseAssetLines`, so the two cannot drift apart.
 */
function photoBatchResponse(
  request: AiCompleteRequest,
  matchText: string,
  dir: string,
): MockResolution | undefined {
  if (request.taskTag !== PHOTO_ANALYSIS_TASK) return undefined;
  const assets = parseAssetLines(matchText);
  if (assets.length === 0) return undefined;

  const itemSchema = photoAnalysisItemSchema(request.jsonSchema);
  const analyses = assets.map((asset) => {
    const canned = findFixture(PHOTO_ANALYSIS_TASK, asset.basename, dir);
    const analysis =
      canned?.images?.[asset.basename] ??
      plainObject(canned?.response) ??
      (itemSchema ? synthesizeFromJsonSchema(itemSchema) : {});
    return { assetId: asset.assetId, analysis };
  });
  return { text: JSON.stringify({ analyses }, null, 2), source: 'photo-batch' };
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `{analyses: [{assetId, analysis: <this>}]}` — dug out so we can synthesise it. */
function photoAnalysisItemSchema(
  jsonSchema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const analyses = (jsonSchema?.['properties'] as Record<string, unknown> | undefined)?.[
    'analyses'
  ];
  const items = (analyses as Record<string, unknown> | undefined)?.['items'];
  const analysis = (items as Record<string, unknown> | undefined)?.['properties'];
  const inner = (analysis as Record<string, unknown> | undefined)?.['analysis'];
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
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
    const resolution = resolveMockResponse(request);
    const inputTokens = request.messages.reduce(
      (n, m) =>
        n + contentParts(m).reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0),
      0,
    );
    return {
      text: resolution.text,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      usage: { inputTokens, outputTokens: resolution.text.length, durationMs: 0 },
      raw: {
        provider: MOCK_PROVIDER_ID,
        images: countImages(request.messages),
        source: resolution.source,
        ...(resolution.fixtureId ? { fixtureId: resolution.fixtureId } : {}),
      },
    };
  },
};
