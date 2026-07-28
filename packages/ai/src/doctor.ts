/**
 * `pnpm ai:doctor` — thirty seconds that answer "is my AI set up actually going
 * to work?" before someone finds out during an interview.
 *
 * The important property is that it degrades. A missing CLI, an unset key, a
 * provider with no vision: each is one ❌ row with a reason and a remedy, never
 * a stack trace and never a hang. Exit code 1 if anything failed, so it is
 * usable in a script.
 */
import { z } from 'zod';
import { generateObject } from './generate-object';
import { getProvider, hasProvider, listProviderIds } from './registry';
import {
  AI_TASKS,
  decidingEnvVar,
  ignoredTestProviders,
  normalizeTask,
  providerIdForTask,
  type AiTask,
  type AiTaskName,
  type Env,
} from './resolve';
import { isCheckable, type AiProvider } from './types';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export type DoctorCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs?: number;
};

export type DoctorReport = {
  task: AiTask;
  providerId: string;
  /** The env var that chose this provider, so a person knows what to edit. */
  envVar: string;
  checks: DoctorCheck[];
  ok: boolean;
};

/** Toy schema for the structured-output check. Small on purpose. */
export const DoctorSchema = z
  .object({
    colour: z.string().min(1),
    count: z.number().int().min(0),
    calm: z.boolean(),
  })
  .strict();

export type DoctorOptions = {
  env?: Env;
  /** Which tasks to check. Defaults to every distinct configured provider. */
  tasks?: AiTaskName[];
  /** A real image path for the vision check. Skipped when absent. */
  fixturePhoto?: string;
  /** Injectable for tests. */
  resolve?: (task: AiTask, env: Env) => AiProvider;
};

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport[]> {
  const env = options.env ?? process.env;
  const tasks = (options.tasks ?? [...AI_TASKS]).map(normalizeTask);
  const reports: DoctorReport[] = [];

  const seen = new Set<string>();
  for (const task of tasks) {
    const providerId = providerIdForTask(task, env);
    // One report per distinct provider: checking the same CLI six times is six
    // times the wait for the same answer.
    const key = `${providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reports.push(await checkProvider(task, providerId, env, options));
  }
  return reports;
}

async function checkProvider(
  task: AiTask,
  providerId: string,
  env: Env,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const envVar = decidingEnvVar(task, env);
  const checks: DoctorCheck[] = [];

  if (!hasProvider(providerId)) {
    checks.push({
      name: 'registered',
      status: 'fail',
      detail: `no adapter called "${providerId}". Known: ${listProviderIds().join(', ')}.`,
    });
    return { task, providerId, envVar, checks, ok: false };
  }

  const provider = options.resolve ? options.resolve(task, env) : getProvider(providerId);

  if (isCheckable(provider)) {
    const availability = provider.checkAvailability(env);
    checks.push({
      name: 'available',
      status: availability.ok ? 'pass' : 'fail',
      detail: availability.ok
        ? (availability.reason ?? 'ready')
        : `${availability.reason ?? 'unavailable'}. ${availability.remedy ?? ''}`.trim(),
    });
    if (!availability.ok) {
      for (const name of ['text', 'generateObject', 'vision', 'session resume']) {
        checks.push({ name, status: 'skip', detail: 'skipped — provider is not available' });
      }
      return { task, providerId, envVar, checks, ok: false };
    }
  } else {
    checks.push({ name: 'available', status: 'pass', detail: 'no setup needed' });
  }

  checks.push(
    await timed('text', async () => {
      const result = await provider.complete({
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        taskTag: 'doctor',
      });
      const text = result.text.trim();
      if (text.length === 0) throw new Error('empty response');
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }),
  );

  checks.push(
    await timed('generateObject', async () => {
      const result = await generateObject(provider, DoctorSchema, {
        taskTag: 'doctor',
        messages: [
          {
            role: 'user',
            content:
              'Return an object describing a calm blue room with three chairs: ' +
              'colour, count, calm.',
          },
        ],
      });
      return (
        `ok in ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}` +
        `${result.salvaged ? ' (salvaged from prose)' : ''}`
      );
    }),
  );

  if (!provider.capabilities.vision) {
    checks.push({ name: 'vision', status: 'skip', detail: 'provider does not do vision' });
  } else if (!options.fixturePhoto) {
    checks.push({ name: 'vision', status: 'skip', detail: 'no fixture photo to look at' });
  } else {
    const photo = options.fixturePhoto;
    checks.push(
      await timed('vision', async () => {
        const result = await provider.complete({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'In five words or fewer, what is in this image?' },
                { type: 'image', source: 'path', path: photo },
              ],
            },
          ],
          taskTag: 'doctor',
        });
        const text = result.text.trim().replace(/\s+/g, ' ');
        if (text.length === 0) throw new Error('empty response');
        return text.length > 60 ? `${text.slice(0, 60)}…` : text;
      }),
    );
  }

  if (!provider.capabilities.nativeSessions) {
    checks.push({ name: 'session resume', status: 'skip', detail: 'provider has no sessions' });
  } else {
    checks.push(
      await timed('session resume', async () => {
        const first = await provider.complete({
          messages: [{ role: 'user', content: 'Remember the word "lantern". Reply with: ok' }],
          taskTag: 'doctor',
        });
        if (!first.sessionId) throw new Error('no session id came back');
        const second = await provider.complete({
          messages: [{ role: 'user', content: 'What word did I ask you to remember?' }],
          sessionId: first.sessionId,
          taskTag: 'doctor',
        });
        return /lantern/i.test(second.text)
          ? `resumed ${first.sessionId.slice(0, 8)}…`
          : `resumed, but the answer did not mention it: ${second.text.slice(0, 40)}`;
      }),
    );
  }

  return {
    task,
    providerId,
    envVar,
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

async function timed(name: string, run: () => Promise<string>): Promise<DoctorCheck> {
  const started = Date.now();
  try {
    const detail = await run();
    return { name, status: 'pass', detail, durationMs: Date.now() - started };
  } catch (err) {
    return {
      name,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* printing                                                                    */
/* -------------------------------------------------------------------------- */

const MARK: Record<CheckStatus, string> = { pass: '✅', fail: '❌', skip: '·' };

export function formatDoctorReport(
  reports: readonly DoctorReport[],
  env: Env = process.env,
): string {
  const lines: string[] = [];
  const ignored = ignoredTestProviders(env);
  if (ignored.length > 0) {
    lines.push(`Note: NODE_ENV=test forces the mock provider; ignoring ${ignored.join(', ')}.`, '');
  }

  for (const report of reports) {
    lines.push(`${report.providerId}  (chosen by ${report.envVar})`);
    const width = Math.max(...report.checks.map((c) => c.name.length), 10);
    for (const check of report.checks) {
      const time = check.durationMs === undefined ? '' : `  ${formatMs(check.durationMs)}`;
      lines.push(`  ${MARK[check.status]}  ${check.name.padEnd(width)}  ${check.detail}${time}`);
    }
    lines.push('');
  }

  const failed = reports.filter((r) => !r.ok);
  lines.push(
    failed.length === 0
      ? 'All configured providers are working.'
      : `${failed.length} provider${failed.length === 1 ? ' needs' : 's need'} attention: ` +
          failed.map((r) => r.providerId).join(', '),
  );
  return lines.join('\n');
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function doctorExitCode(reports: readonly DoctorReport[]): number {
  return reports.every((report) => report.ok) ? 0 : 1;
}
