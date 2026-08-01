/**
 * Put the worker down and take the workspace with it.
 *
 * Nothing this suite made is worth keeping — it is one imaginary family — and
 * leaving a stray worker polling a deleted database is how a developer ends up
 * with a mystery process at nine the next morning.
 */
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { E2E_DIR } from './env';

export default async function globalTeardown(): Promise<void> {
  const worker = (globalThis as Record<string, unknown>)['__colE2eWorker'] as
    ChildProcess | undefined;

  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    // It finishes the job in flight; a render will not be one by now.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill('SIGKILL');
        resolve();
      }, 5_000);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  if (!process.env['E2E_KEEP']) rmSync(E2E_DIR, { recursive: true, force: true });
}
