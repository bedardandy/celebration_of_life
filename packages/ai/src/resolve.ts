import { getProvider } from './registry';
import { MOCK_PROVIDER_ID } from './providers/mock';
import type { AiProvider } from './types';

/**
 * Tasks that may want a different provider. Vision work might go to a local
 * model while the interview goes to a subscription CLI; the caller names a task
 * rather than a vendor.
 */
export const AI_TASKS = ['default', 'interview', 'vision', 'curation', 'edl', 'caption'] as const;
export type AiTask = (typeof AI_TASKS)[number];

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
export function providerIdForTask(task: AiTask = 'default', env: Env = process.env): string {
  if (env['NODE_ENV'] === 'test') return MOCK_PROVIDER_ID;
  const specific = task === 'default' ? undefined : env[taskEnvVar(task)];
  return (specific ?? env['AI_PROVIDER'] ?? MOCK_PROVIDER_ID).trim() || MOCK_PROVIDER_ID;
}

/** Resolve a task to a registered provider. Throws if the id is unknown. */
export function resolveProvider(task: AiTask = 'default', env: Env = process.env): AiProvider {
  return getProvider(providerIdForTask(task, env));
}
