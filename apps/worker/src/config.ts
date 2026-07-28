import { hostname } from 'node:os';
import { DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS } from '@col/db';
import type { JobType } from '@col/schemas';

export type WorkerConfig = {
  /** Identifies the lease holder. Shows up in `jobs.locked_by`. */
  workerId: string;
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  /** Restrict this process to certain job types (e.g. a render-only worker). */
  types?: readonly JobType[];
  databaseUrl?: string;
};

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const types = env['WORKER_JOB_TYPES']
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean) as JobType[] | undefined;

  return {
    workerId: env['WORKER_ID']?.trim() || `${hostname()}-${process.pid}`,
    pollIntervalMs: intFromEnv('WORKER_POLL_INTERVAL_MS', 1_500, env),
    leaseMs: intFromEnv('WORKER_LEASE_MS', DEFAULT_LEASE_MS, env),
    maxAttempts: intFromEnv('WORKER_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, env),
    ...(types && types.length > 0 ? { types } : {}),
    ...(env['DATABASE_URL'] ? { databaseUrl: env['DATABASE_URL'] } : {}),
  };
}
