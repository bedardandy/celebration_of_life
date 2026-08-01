import { createRegistry } from './types';
import { noopHandler } from './noop';
import { ingestAssetHandler } from './ingest-asset';
import { analyzePhotoBatchHandler } from './analyze-photo-batch';
import { generateEdlHandler } from './generate-edl';
import { renderHandler } from './render';
import { sendEmailHandler } from './send-email';

export * from './types';
export {
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
  generateEdlHandler,
  renderHandler,
  sendEmailHandler,
};
export { setIngestBlobStore } from './ingest-asset';
export { setRenderBlobStore, runRender } from './render';

/**
 * Every job type the worker can run.
 *
 * A later phase adds purge-blobs here — an unregistered type fails loudly
 * rather than sitting in the queue forever.
 */
export const handlers = createRegistry([
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
  generateEdlHandler,
  renderHandler,
  sendEmailHandler,
]);
