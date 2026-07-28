/**
 * Recording an upload.
 *
 * The bytes are already in the blob store by the time this runs; what happens
 * here is the row and the job. Both in one place because the pair has to stay
 * consistent: a media_asset with no ingest job is a photo that never appears,
 * and an ingest job with no row is a worker error at two in the morning.
 *
 * Nothing here decodes an image. Uploading has to stay fast on a phone on a
 * train — the family's cousin taps "add photos", sees them land, and closes the
 * tab; the worker does the slow part afterwards.
 */
import { enqueue, insertOne, mediaAssets, type Db, type MediaAsset } from '@col/db';
import { isImageMime, isVideoMime, normalizeUploadMime } from '@col/media';

/** 60 MB. Comfortably above a 48-megapixel HEIC, below a feature film. */
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** How many files one request may carry. Uppy sends them one at a time anyway. */
export const MAX_FILES_PER_REQUEST = 40;

export type UploadRejection = 'too-large' | 'unsupported-type' | 'empty';

export const UPLOAD_REJECTION_MESSAGE: Record<UploadRejection, string> = {
  'too-large': 'That file is very large. If it is a video, a shorter clip will work better.',
  'unsupported-type': 'We can take photos and videos. That one looks like something else.',
  empty: 'That file arrived empty. It may be worth trying again.',
};

export function checkUpload(input: {
  mime: string;
  byteSize: number;
  filename?: string;
}): UploadRejection | undefined {
  if (input.byteSize <= 0) return 'empty';
  if (input.byteSize > MAX_UPLOAD_BYTES) return 'too-large';
  const mime = normalizeUploadMime(input.mime, input.filename);
  if (!isImageMime(mime) && !isVideoMime(mime)) return 'unsupported-type';
  return undefined;
}

/** Filenames are shown back to people, so they are kept — but never trusted. */
export function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? name;
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

export type RecordUploadInput = {
  memorialId: string;
  /** Pre-generated so the blob key could be written before the row exists. */
  assetId: string;
  blobKey: string;
  mime: string;
  byteSize: number;
  originalFilename?: string | null;
  uploadedByParticipantId?: string | null;
};

export type RecordedUpload = {
  asset: MediaAsset;
  jobId: string;
};

export function recordUpload(db: Db, input: RecordUploadInput): RecordedUpload {
  const mime = normalizeUploadMime(input.mime, input.originalFilename ?? undefined);
  const asset = insertOne(db, mediaAssets, {
    id: input.assetId,
    memorialId: input.memorialId,
    uploadedByParticipantId: input.uploadedByParticipantId ?? null,
    originalFilename: safeFilename(input.originalFilename ?? undefined),
    mime,
    byteSize: input.byteSize,
    blobKey: input.blobKey,
    ingestState: 'uploaded',
    curationState: 'pending',
  });

  // Priority above the default so a family watching the grid sees thumbnails
  // appear while other work (analysis, purges) waits its turn.
  const job = enqueue(
    db,
    {
      type: 'ingest-asset',
      memorialId: input.memorialId,
      assetId: asset.id,
      blobKey: input.blobKey,
    },
    { memorialId: input.memorialId, priority: 5 },
  );

  return { asset, jobId: job.id };
}
