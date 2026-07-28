import { createRegistry } from './types';
import { noopHandler } from './noop';
import { ingestAssetHandler } from './ingest-asset';
import { analyzePhotoBatchHandler } from './analyze-photo-batch';

export * from './types';
export { noopHandler, ingestAssetHandler, analyzePhotoBatchHandler };
export { setIngestBlobStore } from './ingest-asset';

/**
 * Every job type the worker can run.
 *
 * Later phases add generate-edl, render, purge-blobs and send-email here — an
 * unregistered type fails loudly rather than sitting in the queue forever.
 */
export const handlers = createRegistry([
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
]);
