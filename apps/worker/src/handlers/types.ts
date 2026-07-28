import type { Db, JobRow } from '@col/db';
import type { JobPayload, JobPayloadFor, JobType } from '@col/schemas';
import type { Logger } from '../log';

export type HandlerContext<P extends JobPayload = JobPayload> = {
  db: Db;
  job: JobRow;
  payload: P;
  workerId: string;
  /** Aborted on shutdown. Long handlers (renders) must honour it. */
  signal: AbortSignal;
  /** Renew the lease. Returns false if the lease was lost — stop work if so. */
  heartbeat: () => boolean;
  log: Logger;
};

export type JobHandler = (ctx: HandlerContext) => Promise<unknown>;

export type HandlerEntry = {
  type: JobType;
  run: JobHandler;
};

/**
 * Binds a handler to one job type and narrows the payload for it, so handlers
 * are written against their own payload type and the dispatcher stays dumb.
 */
export function defineHandler<T extends JobType>(
  type: T,
  run: (ctx: HandlerContext<JobPayloadFor<T>>) => Promise<unknown>,
): HandlerEntry {
  return {
    type,
    // async so a routing mistake surfaces as a rejected promise, not a throw
    // from inside the dispatcher's synchronous section.
    run: async (ctx: HandlerContext) => {
      if (ctx.payload.type !== type) {
        throw new Error(`handler "${type}" received a "${ctx.payload.type}" payload`);
      }
      return run(ctx as HandlerContext<JobPayloadFor<T>>);
    },
  };
}

export class UnknownJobTypeError extends Error {
  constructor(
    readonly jobType: string,
    readonly known: readonly string[],
  ) {
    super(`No handler registered for job type "${jobType}". Registered: ${known.join(', ')}.`);
    this.name = 'UnknownJobTypeError';
  }
}

export type HandlerRegistry = {
  get(type: string): HandlerEntry | undefined;
  require(type: string): HandlerEntry;
  types(): JobType[];
};

export function createRegistry(entries: readonly HandlerEntry[]): HandlerRegistry {
  const map = new Map<string, HandlerEntry>();
  for (const entry of entries) {
    if (map.has(entry.type)) throw new Error(`duplicate handler for job type "${entry.type}"`);
    map.set(entry.type, entry);
  }
  return {
    get: (type) => map.get(type),
    require: (type) => {
      const entry = map.get(type);
      if (!entry) throw new UnknownJobTypeError(type, [...map.keys()]);
      return entry;
    },
    types: () => [...map.keys()] as JobType[],
  };
}
