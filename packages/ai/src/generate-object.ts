/**
 * Structured output, the same way, whatever the provider is.
 *
 * Native JSON-Schema support is treated as an optimisation and nothing more:
 * providers that have it get the schema handed over properly, providers that do
 * not get it appended to the prompt, and both paths then go through the same
 * salvage → validate → repair sequence. That is what keeps "swap the provider"
 * a one-line change rather than a rewrite.
 *
 * The repair loop is bounded (2 attempts by default). Past that we raise a typed
 * `AiSchemaError` carrying every attempt, so a caller can log the detail and
 * show a person one calm sentence instead of a stack trace.
 */
import { z } from 'zod';
import { parseJsonLoose } from './json';
import {
  AiError,
  contentParts,
  messageText,
  textPart,
  type AiCompleteRequest,
  type AiMessage,
  type AiProvider,
} from './types';

/**
 * Marks the schema block appended to a prompt. Exported because the mock
 * provider strips it before matching fixtures — otherwise every fixture key
 * would change whenever a schema gained a field.
 */
export const SCHEMA_INSTRUCTION_MARKER = '\n\n--- required JSON shape ---\n';

/** Marks a repair turn, so the mock (and any log reader) can tell them apart. */
export const REPAIR_MARKER = '[schema-repair]';

export const DEFAULT_MAX_REPAIRS = 2;

export class AiSchemaError extends AiError {
  constructor(
    readonly taskTag: string,
    readonly providerId: string,
    /** How many completions were requested in total, repairs included. */
    readonly attempts: number,
    /** Raw text of the final attempt — the thing to look at when debugging. */
    readonly lastRaw: string,
    /** One line per validation problem, from the final attempt. */
    readonly issues: readonly string[],
  ) {
    super(
      `AI response for "${taskTag}" did not match the expected shape after ${attempts} ` +
        `attempt${attempts === 1 ? '' : 's'} (provider "${providerId}"): ` +
        (issues.length > 0 ? issues.join('; ') : 'unparseable output'),
    );
    this.name = 'AiSchemaError';
  }
}

/**
 * One plain sentence for a person who is not having a technical day. Callers
 * put this on screen; the real error goes to the log.
 */
export function friendlyAiMessage(error: unknown): string {
  if (error instanceof AiSchemaError) {
    return 'That answer did not come back in one piece. Nothing you wrote was lost — try again in a moment.';
  }
  if (error instanceof AiError) {
    return 'We could not reach the writing assistant just now. Nothing you wrote was lost — try again in a moment.';
  }
  return 'Something went wrong on our side. Nothing you wrote was lost — try again in a moment.';
}

export type GenerateObjectOptions = {
  messages: AiMessage[];
  /** Provider-side conversation to continue, when the provider has them. */
  sessionId?: string;
  /** Names the job being done: picks the fixture folder, labels errors/logs. */
  taskTag: string;
  maxRepairs?: number;
  maxTokens?: number;
  temperature?: number;
};

export type GenerateObjectResult<T> = {
  object: T;
  /** Raw text of the attempt that finally validated. */
  raw: string;
  sessionId?: string;
  /** Completions requested, repairs included. 1 means it worked first time. */
  attempts: number;
  /** True when the JSON had to be dug out of surrounding prose. */
  salvaged: boolean;
};

export async function generateObject<T extends z.ZodType>(
  provider: AiProvider,
  schema: T,
  options: GenerateObjectOptions,
): Promise<GenerateObjectResult<z.output<T>>> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const native = provider.capabilities.nativeJsonSchema;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;

  // The schema always travels on the request: adapters that cannot use it
  // ignore it, and the mock uses it to synthesise a stand-in.
  const messages = native
    ? [...options.messages]
    : appendSchemaInstruction(options.messages, jsonSchema);

  let sessionId = options.sessionId;
  let attempts = 0;
  let lastRaw = '';
  let lastIssues: string[] = ['no attempt was made'];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const request: AiCompleteRequest = {
      messages,
      jsonSchema,
      taskTag: options.taskTag,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    };

    const result = await provider.complete(request);
    attempts += 1;
    lastRaw = result.text;
    if (result.sessionId !== undefined) sessionId = result.sessionId;

    const parsed = parseJsonLoose(result.text);
    if (parsed.ok) {
      const validated = schema.safeParse(parsed.value);
      if (validated.success) {
        return {
          object: validated.data as z.output<T>,
          raw: result.text,
          ...(sessionId === undefined ? {} : { sessionId }),
          attempts,
          salvaged: parsed.salvaged,
        };
      }
      lastIssues = summarizeIssues(validated.error);
    } else {
      lastIssues = [`response was not JSON: ${parsed.error}`];
    }

    if (attempt === maxRepairs) break;
    messages.push(
      { role: 'assistant', content: truncate(result.text, 4000) },
      { role: 'user', content: repairInstruction(lastIssues, jsonSchema) },
    );
  }

  throw new AiSchemaError(options.taskTag, provider.id, attempts, lastRaw, lastIssues);
}

/* -------------------------------------------------------------------------- */

export function summarizeIssues(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Schema-in-prompt, appended to the final user message rather than sent as a
 * new one — some CLI adapters flatten the conversation to a single prompt, and
 * an instruction stranded in its own turn is the first thing they lose.
 */
export function appendSchemaInstruction(
  messages: readonly AiMessage[],
  jsonSchema: Record<string, unknown>,
): AiMessage[] {
  const instruction =
    `${SCHEMA_INSTRUCTION_MARKER}${JSON.stringify(jsonSchema, null, 2)}\n\n` +
    'Respond with ONLY a JSON object matching this schema. No commentary, no code fences.';

  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i];
    if (message?.role !== 'user') continue;
    out[i] = {
      role: 'user',
      content: [...contentParts(message), textPart(instruction)],
    };
    return out;
  }
  out.push({ role: 'user', content: instruction });
  return out;
}

function repairInstruction(issues: readonly string[], jsonSchema: Record<string, unknown>): string {
  return [
    `${REPAIR_MARKER} That response did not match the required shape.`,
    'Problems:',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Fix and return only corrected JSON matching this schema:',
    JSON.stringify(jsonSchema),
  ].join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** True when this message is one of our own repair turns. */
export function isRepairMessage(message: AiMessage): boolean {
  return message.role === 'user' && messageText(message).includes(REPAIR_MARKER);
}

/**
 * The text a fixture should be matched against: the last user message that is
 * not a repair turn, with the appended schema block removed.
 */
export function requestMatchText(messages: readonly AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user' || isRepairMessage(message)) continue;
    return stripSchemaInstruction(messageText(message));
  }
  return '';
}

export function stripSchemaInstruction(text: string): string {
  const at = text.indexOf(SCHEMA_INSTRUCTION_MARKER);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

/** True when the conversation already contains at least one repair turn. */
export function hasRepairTurn(messages: readonly AiMessage[]): boolean {
  return messages.some(isRepairMessage);
}
