/**
 * The Codex CLI as a provider.
 *
 * Same reasoning as the Claude adapter — a subscription rather than a meter —
 * with one extra wrinkle: image support has moved around between Codex
 * releases. Rather than guess, we probe `codex exec --help` once and set the
 * vision capability from what it says. A provider that claims vision it does not
 * have fails in the middle of a photo batch; a provider that admits it fails at
 * boot, by name, which is the failure we can live with.
 */
import {
  AiCallError,
  AiProviderUnavailableError,
  AiTimeoutError,
  type AiAvailability,
  type AiCapabilities,
  type AiCompleteRequest,
  type AiCompleteResult,
  type CheckableProvider,
} from '../types';
import { flattenToPrompt, materializeImages } from './cli-prompt';
import {
  DEFAULT_CLI_TIMEOUT_MS,
  binaryExists,
  createMutex,
  firstStderrLine,
  runCommand,
  type RunResult,
} from './process';
import { spawnSync } from 'node:child_process';

export const CODEX_CLI_PROVIDER_ID = 'codex-cli';
export const CODEX_CLI_BINARY_ENV = 'CODEX_CLI_PATH';

const oneAtATime = createMutex();

export function codexBinary(env: Record<string, string | undefined> = process.env): string {
  return env[CODEX_CLI_BINARY_ENV]?.trim() || 'codex';
}

export function codexTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env['AI_CLI_TIMEOUT_MS'] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLI_TIMEOUT_MS;
}

export function checkCodexCli(
  env: Record<string, string | undefined> = process.env,
): AiAvailability {
  const binary = codexBinary(env);
  if (binaryExists(binary)) return { ok: true };
  return {
    ok: false,
    reason: `the "${binary}" command is not on PATH`,
    remedy:
      'Install the Codex CLI and run `codex login` once, ' +
      `or set ${CODEX_CLI_BINARY_ENV} to its full path.`,
  };
}

/* -------------------------------------------------------------------------- */
/* image-support probe                                                         */
/* -------------------------------------------------------------------------- */

let imageSupport: boolean | undefined;

/** Test hook: state the answer instead of probing. `undefined` re-arms the probe. */
export function setCodexImageSupport(value: boolean | undefined): void {
  imageSupport = value;
}

/** Does `codex exec --help` mention images? Probed once, then remembered. */
export function probeCodexImageSupport(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (imageSupport !== undefined) return imageSupport;

  const forced = env['AI_CODEX_VISION']?.trim().toLowerCase();
  if (forced === '1' || forced === 'true') return (imageSupport = true);
  if (forced === '0' || forced === 'false') return (imageSupport = false);

  const binary = codexBinary(env);
  if (!binaryExists(binary)) return (imageSupport = false);

  const probe = spawnSync(binary, ['exec', '--help'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const help = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.toLowerCase();
  return (imageSupport = /(^|\s)-i(\s|,)|--image|<image>|image file/.test(help));
}

/* -------------------------------------------------------------------------- */
/* JSONL stream                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `codex exec --json` prints a JSON object per line. We want the final
 * assistant/agent message and the session id; everything else is progress
 * chatter, and the shapes have changed between versions, so this reads
 * defensively rather than insisting on one schema.
 */
export function parseCodexJsonl(stdout: string): {
  text: string;
  sessionId?: string;
  events: unknown[];
} {
  const events: unknown[] = [];
  let text = '';
  let sessionId: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    events.push(event);

    const id = pickSessionId(event);
    if (id) sessionId = id;

    const message = pickAssistantText(event);
    if (message !== undefined) text = message;
  }

  return { text, ...(sessionId === undefined ? {} : { sessionId }), events };
}

function pickSessionId(event: Record<string, unknown>): string | undefined {
  for (const key of ['session_id', 'sessionId', 'thread_id', 'conversation_id']) {
    const value = event[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const nested = event['msg'] ?? event['payload'] ?? event['data'];
  if (typeof nested === 'object' && nested !== null) {
    return pickSessionId(nested as Record<string, unknown>);
  }
  return undefined;
}

function pickAssistantText(event: Record<string, unknown>): string | undefined {
  const type = String(event['type'] ?? (event['msg'] as Record<string, unknown>)?.['type'] ?? '');
  const isAssistant = /agent_message|assistant|item\.completed|task_complete/.test(type);

  const candidates: unknown[] = [
    event['message'],
    event['text'],
    event['last_agent_message'],
    (event['msg'] as Record<string, unknown> | undefined)?.['message'],
    (event['msg'] as Record<string, unknown> | undefined)?.['text'],
    (event['item'] as Record<string, unknown> | undefined)?.['text'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0 && isAssistant) {
      return candidate;
    }
  }
  return undefined;
}

export function buildCodexArgs(input: {
  prompt: string;
  sessionId?: string;
  imagePaths?: readonly string[];
}): string[] {
  const args = input.sessionId
    ? ['exec', 'resume', input.sessionId, '--json', '--sandbox', 'read-only']
    : ['exec', '--json', '--sandbox', 'read-only'];
  for (const image of input.imagePaths ?? []) args.push('-i', image);
  args.push(input.prompt);
  return args;
}

/* -------------------------------------------------------------------------- */

export const codexCliProvider: CheckableProvider = {
  id: CODEX_CLI_PROVIDER_ID,
  get capabilities(): AiCapabilities {
    const vision = probeCodexImageSupport();
    return {
      text: true,
      nativeJsonSchema: false,
      vision,
      visionInput: vision ? 'file-path' : 'none',
      nativeSessions: true,
      maxImagesPerCall: vision ? 6 : 0,
      costTier: 'subscription',
    };
  },
  checkAvailability: checkCodexCli,
  async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
    const availability = checkCodexCli();
    if (!availability.ok) {
      throw new AiProviderUnavailableError(
        CODEX_CLI_PROVIDER_ID,
        availability.reason ?? 'unavailable',
        availability.remedy,
      );
    }

    const vision = probeCodexImageSupport();
    const materialized = materializeImages(request.messages);
    // With image support the files ride on `-i`; without it they are named in
    // the prompt text, so at least the model knows what it was not shown.
    const imagePaths = vision ? materialized : [];
    const prompt = flattenToPrompt(request.messages, vision ? [] : materialized);
    const timeoutMs = codexTimeoutMs();

    return oneAtATime(async () => {
      const started = Date.now();
      const result: RunResult = await runCommand(
        codexBinary(),
        buildCodexArgs({
          prompt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          imagePaths,
        }),
        { timeoutMs },
      );

      if (result.timedOut) throw new AiTimeoutError(CODEX_CLI_PROVIDER_ID, timeoutMs);
      if (result.code !== 0) {
        throw new AiCallError(
          CODEX_CLI_PROVIDER_ID,
          `exited with code ${result.code}`,
          firstStderrLine(result.stderr) || result.stdout.slice(0, 300),
        );
      }

      const parsed = parseCodexJsonl(result.stdout);
      if (parsed.text.trim().length === 0) {
        throw new AiCallError(
          CODEX_CLI_PROVIDER_ID,
          'produced no assistant message',
          firstStderrLine(result.stderr) || result.stdout.slice(0, 300),
        );
      }
      return {
        text: parsed.text,
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        usage: { outputTokens: parsed.text.length, durationMs: Date.now() - started },
        raw: { events: parsed.events.length },
      };
    });
  },
};
