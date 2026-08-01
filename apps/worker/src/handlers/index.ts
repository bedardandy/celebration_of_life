import { createRegistry } from './types';
import { noopHandler } from './noop';
import { ingestAssetHandler } from './ingest-asset';
import { analyzePhotoBatchHandler } from './analyze-photo-batch';
import { generateEdlHandler } from './generate-edl';
import { renderHandler } from './render';
import { sendEmailHandler } from './send-email';
import { detectFacesHandler } from './detect-faces';
import { enhanceAssetHandler } from './enhance-asset';
import { importGooglePhotosHandler } from './import-google-photos';

export * from './types';
export {
  noopHandler,
  ingestAssetHandler,
  analyzePhotoBatchHandler,
  generateEdlHandler,
  renderHandler,
  sendEmailHandler,
  detectFacesHandler,
  enhanceAssetHandler,
  importGooglePhotosHandler,
};
export { setIngestBlobStore } from './ingest-asset';
export { setRenderBlobStore, runRender } from './render';
export { setFaceEngine, setFacesBlobStore, FACE_VARIANT } from './detect-faces';
export { setRestorer, setEnhanceBlobStore } from './enhance-asset';
export { setImportBlobStore, setGoogleFetch } from './import-google-photos';

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
  detectFacesHandler,
  enhanceAssetHandler,
  importGooglePhotosHandler,
]);
