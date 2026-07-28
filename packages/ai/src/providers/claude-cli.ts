/**
 * The Claude Code CLI as a provider.
 *
 * This is the adapter the developer of this product actually uses day to day:
 * it spends a flat-rate subscription rather than per-token billing, which is
 * what makes a long guided interview affordable to develop against.
 *
 * `--allowedTools Read` and nothing else, deliberately. The CLI is a capable
 * agent and we are handing it a family's photographs; it needs to open files and
 * it needs to do nothing else at all.
 */
import {
  AiCallError,
  AiProviderUnavailableError,
  AiTimeoutError,
  type AiAvailability,
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

export const CLAUDE_CLI_PROVIDER_ID = 'claude-cli';
export const CLAUDE_CLI_BINARY_ENV = 'CLAUDE_CLI_PATH';

/** One conversation at a time. The CLI keeps session state on disk. */
const oneAtATime = createMutex();

export function claudeBinary(env: Record<string, string | undefined> = process.env): string {
  return env[CLAUDE_CLI_BINARY_ENV]?.trim() || 'claude';
}

export function claudeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env['AI_CLI_TIMEOUT_MS'] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLI_TIMEOUT_MS;
}

export function checkClaudeCli(
  env: Record<string, string | undefined> = process.env,
): AiAvailability {
  const binary = claudeBinary(env);
  if (binaryExists(binary)) return { ok: true };
  return {
    ok: false,
    reason: `the "${binary}" command is not on PATH`,
    remedy:
      'Install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in, ' +
      `or set ${CLAUDE_CLI_BINARY_ENV} to its full path.`,
  };
}

/** `claude -p … --output-format json` prints this. */
export type ClaudeCliEnvelope = {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function buildClaudeArgs(input: {
  prompt: string;
  sessionId?: string;
  model?: string;
}): string[] {
  const args = ['-p', input.prompt, '--output-format', 'json', '--allowedTools', 'Read'];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  return args;
}

/**
 * Pull the answer out of the CLI's envelope. Kept separate from the spawn so it
 * can be tested against recorded output without a binary anywhere near it.
 */
export function parseClaudeOutput(result: RunResult): {
  text: string;
  sessionId?: string;
  raw: unknown;
} {
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    throw new AiCallError(
      CLAUDE_CLI_PROVIDER_ID,
      'returned no output',
      firstStderrLine(result.stderr),
    );
  }

  let envelope: ClaudeCliEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
  } catch {
    // Older/other output formats print the answer plainly. Better to use it
    // than to fail because the wrapper changed shape.
    return { text: stdout, raw: { stdout } };
  }

  if (envelope.is_error) {
    throw new AiCallError(
      CLAUDE_CLI_PROVIDER_ID,
      `reported an error (${envelope.subtype ?? 'unknown'})`,
      envelope.result ?? firstStderrLine(result.stderr),
    );
  }
  if (typeof envelope.result !== 'string') {
    throw new AiCallError(
      CLAUDE_CLI_PROVIDER_ID,
      'output had no "result" field',
      stdout.slice(0, 400),
    );
  }
  return {
    text: envelope.result,
    ...(envelope.session_id ? { sessionId: envelope.session_id } : {}),
    raw: envelope,
  };
}

export const claudeCliProvider: CheckableProvider = {
  id: CLAUDE_CLI_PROVIDER_ID,
  capabilities: {
    text: true,
    // The CLI has no structured-output mode; the schema goes in the prompt.
    nativeJsonSchema: false,
    vision: true,
    visionInput: 'file-path',
    nativeSessions: true,
    maxImagesPerCall: 10,
    costTier: 'subscription',
  },
  checkAvailability: checkClaudeCli,
  async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
    const availability = checkClaudeCli();
    if (!availability.ok) {
      throw new AiProviderUnavailableError(
        CLAUDE_CLI_PROVIDER_ID,
        availability.reason ?? 'unavailable',
        availability.remedy,
      );
    }

    const imagePaths = materializeImages(request.messages);
    const prompt = flattenToPrompt(request.messages, imagePaths);
    const timeoutMs = claudeTimeoutMs();
    const model = process.env['AI_MODEL_CLAUDE_CLI']?.trim();

    return oneAtATime(async () => {
      const started = Date.now();
      const result = await runCommand(
        claudeBinary(),
        buildClaudeArgs({
          prompt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(model ? { model } : {}),
        }),
        { timeoutMs },
      );

      if (result.timedOut) throw new AiTimeoutError(CLAUDE_CLI_PROVIDER_ID, timeoutMs);
      if (result.code !== 0) {
        throw new AiCallError(
          CLAUDE_CLI_PROVIDER_ID,
          `exited with code ${result.code}`,
          firstStderrLine(result.stderr) || result.stdout.slice(0, 300),
        );
      }

      const parsed = parseClaudeOutput(result);
      const envelope = parsed.raw as ClaudeCliEnvelope;
      return {
        text: parsed.text,
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        usage: {
          ...(envelope?.usage?.input_tokens === undefined
            ? {}
            : { inputTokens: envelope.usage.input_tokens }),
          ...(envelope?.usage?.output_tokens === undefined
            ? {}
            : { outputTokens: envelope.usage.output_tokens }),
          durationMs: Date.now() - started,
        },
        raw: parsed.raw,
      };
    });
  },
};
