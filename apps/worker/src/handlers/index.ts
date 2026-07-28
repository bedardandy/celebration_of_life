import { createRegistry } from './types';
import { noopHandler } from './noop';
import { ingestAssetHandler } from './ingest-asset';
import { analyzePhotoBatchHandler } from './analyze-photo-batch';
import { generateEdlHandler } from './generate-edl';
import { renderHandler } from './render';

export * from './types';
export {
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
  generateEdlHandler,
  renderHandler,
};
export { setIngestBlobStore } from './ingest-asset';
export { setRenderBlobStore, runRender } from './render';

/**
 * Every job type the worker can run.
 *
 * Later phases add purge-blobs and send-email here — an unregistered type fails
 * loudly rather than sitting in the queue forever.
 */
export const handlers = createRegistry([
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
  generateEdlHandler,
  renderHandler,
]);
