/**
 * `pnpm ai:doctor`
 *
 * Thirty seconds that answer "is my AI setup actually going to work?" before a
 * family finds out during an interview. Runs a text call, a structured-output
 * call, a vision call and a session resume against whatever `AI_PROVIDER` and
 * the per-task overrides currently point at, and prints one row per check.
 *
 * It never fails hard. A missing CLI, an unset key or a provider with no vision
 * is a ❌ with a reason and a remedy. Exit code 1 if anything needs attention.
 *
 * Imported by relative path rather than by package name: this script runs from
 * the repo root, which is not a workspace package.
 */
/* eslint-disable no-console */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type AiTaskName,
} from '../packages/ai/src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function parseTasks(argv: readonly string[]): AiTaskName[] | undefined {
  const tasks = argv.filter((arg) => !arg.startsWith('-'));
  return tasks.length > 0 ? (tasks as AiTaskName[]) : undefined;
}

async function main(): Promise<void> {
  const tasks = parseTasks(process.argv.slice(2));
  const photo = path.join(repoRoot, 'fixtures', 'photos', '01-portrait.jpg');

  if (process.env['NODE_ENV'] === 'test') {
    console.log(
      'Note: NODE_ENV=test forces the mock provider. Unset it to check your real setup.\n',
    );
  }

  console.log('Checking AI providers…\n');
  const reports = await runDoctor({
    ...(tasks ? { tasks } : {}),
    ...(existsSync(photo) ? { fixturePhoto: photo } : {}),
  });

  console.log(formatDoctorReport(reports));
  const code = doctorExitCode(reports);
  if (code !== 0) {
    console.log(
      '\nSee docs/ai-providers.md for the exact environment variables each adapter needs.',
    );
  }
  process.exitCode = code;
}

main().catch((error: unknown) => {
  // Even the doctor's own failure has to be readable.
  console.error(
    `ai:doctor could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
