import { getProvider, hasProvider, listProviderIds } from './registry';
import { MOCK_PROVIDER_ID } from './providers/mock';
import {
  AiCapabilityError,
  AiProviderNotFoundError,
  AiProviderUnavailableError,
  isCheckable,
  type AiCapabilities,
  type AiProvider,
} from './types';

/**
 * Tasks that may want a different provider. Vision work might go to a local
 * model while the interview goes to a subscription CLI; the caller names a task
 * rather than a vendor.
 */
export const AI_TASKS = ['default', 'interview', 'vision', 'curation', 'edl', 'caption'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/**
 * The names the rest of the product uses when it asks for a provider, mapped to
 * the env var suffix a person actually types. Callers say what the work *is*
 * ('photo-analysis'); the env var stays short ('AI_PROVIDER_VISION').
 */
export const AI_TASK_ALIASES = {
  'photo-analysis': 'vision',
  'edl-generation': 'edl',
  'copy-drafting': 'caption',
} as const satisfies Record<string, AiTask>;

export type AiTaskName = AiTask | keyof typeof AI_TASK_ALIASES;

export function normalizeTask(task: AiTaskName): AiTask {
  return (AI_TASK_ALIASES as Record<string, AiTask>)[task] ?? (task as AiTask);
}

/** What each task cannot do without. Checked at resolve time, not at call time. */
export const TASK_REQUIREMENTS: Partial<
  Record<AiTask, Partial<Pick<AiCapabilities, 'vision' | 'nativeJsonSchema' | 'nativeSessions'>>>
> = {
  vision: { vision: true },
};

export type Env = Record<string, string | undefined>;

/** `AI_PROVIDER_VISION`, `AI_PROVIDER_INTERVIEW`, … */
export function taskEnvVar(task: AiTask): string {
  return `AI_PROVIDER_${task.toUpperCase()}`;
}

/**
 * Which provider id a task should use.
 *
 * Precedence: per-task env override → global `AI_PROVIDER` → mock.
 * In `NODE_ENV=test` the mock is forced: a test run must never reach a network
 * or spend a subscription, no matter what is in the developer's shell.
 */
export function providerIdForTask(task: AiTaskName = 'default', env: Env = process.env): string {
  const resolved = normalizeTask(task);
  if (env['NODE_ENV'] === 'test') return MOCK_PROVIDER_ID;
  const specific = resolved === 'default' ? undefined : env[taskEnvVar(resolved)];
  return (specific ?? env['AI_PROVIDER'] ?? MOCK_PROVIDER_ID).trim() || MOCK_PROVIDER_ID;
}

/** Which env var actually decided this task's provider — named in error messages. */
export function decidingEnvVar(task: AiTaskName = 'default', env: Env = process.env): string {
  const resolved = normalizeTask(task);
  if (resolved !== 'default' && env[taskEnvVar(resolved)]?.trim()) return taskEnvVar(resolved);
  return 'AI_PROVIDER';
}

/**
 * Providers configured in the environment but ignored because this is a test
 * run. Surfaced by `ai:doctor` and by the warning below so nobody spends an
 * afternoon wondering why their CLI is not being called.
 */
export function ignoredTestProviders(env: Env = process.env): string[] {
  if (env['NODE_ENV'] !== 'test') return [];
  const names = ['AI_PROVIDER', ...AI_TASKS.filter((t) => t !== 'default').map(taskEnvVar)];
  return names.filter((name) => {
    const value = env[name]?.trim();
    return Boolean(value) && value !== MOCK_PROVIDER_ID;
  });
}

let warnedAboutTestOverride = false;

/** Only for tests, which need the "already warned" latch reset. */
export function resetResolveWarnings(): void {
  warnedAboutTestOverride = false;
}

/**
 * Resolve a task to a registered, capable, available provider.
 *
 * Everything that can be wrong is wrong *here*, by name, with the env var to
 * change — an unknown id, a provider that cannot see photographs, a CLI that is
 * not installed. The alternative is discovering it three screens into someone's
 * evening.
 */
export function resolveProvider(task: AiTaskName = 'default', env: Env = process.env): AiProvider {
  const resolved = normalizeTask(task);
  const id = providerIdForTask(task, env);

  if (env['NODE_ENV'] === 'test') {
    const ignored = ignoredTestProviders(env);
    if (ignored.length > 0 && !warnedAboutTestOverride) {
      warnedAboutTestOverride = true;
      process.emitWarning(
        `NODE_ENV=test forces the "${MOCK_PROVIDER_ID}" AI provider; ignoring ${ignored.join(', ')}.`,
      );
    }
  }

  if (!hasProvider(id)) throw new AiProviderNotFoundError(id, listProviderIds());
  const provider = getProvider(id);

  const required = TASK_REQUIREMENTS[resolved];
  if (required) {
    const missing = (['vision', 'nativeJsonSchema', 'nativeSessions'] as const).filter(
      (key) => required[key] === true && provider.capabilities[key] !== true,
    );
    if (missing.length > 0) {
      const envVar = decidingEnvVar(task, env);
      throw new AiCapabilityError(
        id,
        missing,
        `The "${task}" task needs it. Set ${envVar} to a provider that can ` +
          `(${capableProviders(missing).join(', ') || 'none registered'}).`,
      );
    }
  }

  if (isCheckable(provider)) {
    const availability = provider.checkAvailability(env);
    if (!availability.ok) {
      throw new AiProviderUnavailableError(
        id,
        availability.reason ?? 'unavailable',
        `${availability.remedy ?? ''} (chosen by ${decidingEnvVar(task, env)})`.trim(),
      );
    }
  }

  return provider;
}

/** Registered providers that have every one of these capabilities. */
export function capableProviders(required: readonly string[]): string[] {
  return listProviderIds().filter((id) => {
    const capabilities = getProvider(id).capabilities as unknown as Record<string, unknown>;
    return required.every((key) => capabilities[key] === true);
  });
}
