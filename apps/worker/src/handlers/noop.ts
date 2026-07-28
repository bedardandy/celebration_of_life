import { defineHandler } from './types';

/** Abortable sleep — a shutdown should not wait on a handler's timer. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The plumbing job. It exists so "is the queue actually working end to end?" is
 * a question with a one-command answer, in dev and in CI, before any real
 * handler exists to confuse the answer.
 */
export const noopHandler = defineHandler('noop', async (ctx) => {
  const sleepMs = ctx.payload.sleepMs;
  ctx.log.debug('noop starting', { jobId: ctx.job.id, sleepMs });
  await sleep(sleepMs, ctx.signal);
  return { sleptMs: sleepMs, ...(ctx.payload.note ? { note: ctx.payload.note } : {}) };
});
