import { createRegistry } from './types';
import { noopHandler } from './noop';

export * from './types';
export { noopHandler };

/**
 * Every job type the worker can run.
 *
 * Phase 0 registers only `noop`. Later phases add ingest-asset, analyze-photo-batch,
 * generate-edl, render, purge-blobs and send-email here — an unregistered type
 * fails loudly rather than sitting in the queue forever.
 */
export const handlers = createRegistry([noopHandler]);
