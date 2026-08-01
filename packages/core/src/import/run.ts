/**
 * The import itself, as domain logic.
 *
 * The worker handler around this is thin on purpose — leases, logging, the
 * sealed token — because what matters is here, where it can be tested against a
 * fake `fetch` with no queue involved:
 *
 *  - photographs land through the *same* path as a phone upload
 *    (`recordUpload` → `ingest-asset`), so nothing downstream has a second case
 *    to handle and a Google photograph is just a photograph;
 *  - a link that has expired costs one photograph, never the import;
 *  - the family is told the truth about what arrived, in one sentence.
 */
import { newId, type Db } from '@col/db';
import { extensionForMime, normalizeUploadMime } from '@col/media';
import { checkUpload, recordUpload, MAX_UPLOAD_BYTES } from '../collect/uploads';
import {
  deletePickerSession,
  downloadPickedItem,
  importSummary,
  listAllPickedItems,
  waitForPickedItems,
  type ImportTally,
  type PickedItem,
} from './google-photos';

/** The slice of BlobStore an import needs. Structural, so @col/storage stays out. */
export type ImportStore = {
  put(key: string, body: Buffer, mime: string): Promise<unknown>;
};

export type ImportInput = {
  memorialId: string;
  sessionId: string;
  accessToken: string;
  /** The organiser: the photographs are attributed to whoever brought them. */
  participantId?: string | null;
  fetchImpl?: typeof fetch;
  /** Between photographs, so a worker can renew its lease. */
  onProgress?: (done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxItems?: number;
};

export type ImportOutcome = {
  tally: ImportTally;
  /** One sentence for the screen. Partial success says so. */
  summary: string;
  assetIds: string[];
  /** Filenames we could not bring, so a log reader can see which. */
  expiredFilenames: string[];
};

export async function runGooglePhotosImport(
  db: Db,
  store: ImportStore,
  input: ImportInput,
): Promise<ImportOutcome> {
  const fetchOptions = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};

  await waitForPickedItems({
    accessToken: input.accessToken,
    sessionId: input.sessionId,
    ...fetchOptions,
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    onWait: () => input.onProgress?.(0, 0),
  });

  const items = await listAllPickedItems({
    accessToken: input.accessToken,
    sessionId: input.sessionId,
    ...fetchOptions,
    ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
  });

  const tally: ImportTally = { added: 0, expired: 0, skipped: 0, total: items.length };
  const assetIds: string[] = [];
  const expiredFilenames: string[] = [];

  let done = 0;
  for (const item of items) {
    done += 1;
    input.onProgress?.(done, items.length);

    const mime = normalizeUploadMime(item.mimeType, item.filename);
    // Google will happily hand back a screen recording; the upload rules are
    // the same ones a cousin's phone meets.
    if (!isMedia(mime)) {
      tally.skipped += 1;
      continue;
    }

    const bytes = await fetchBytes(input, item);
    if (!bytes) {
      tally.expired += 1;
      expiredFilenames.push(item.filename);
      continue;
    }

    const problem = checkUpload({
      mime,
      byteSize: bytes.byteLength,
      filename: item.filename,
    });
    if (problem) {
      tally.skipped += 1;
      continue;
    }

    const assetId = newId();
    const key = `memorial/${input.memorialId}/original/${assetId}.${extensionForMime(mime)}`;
    await store.put(key, bytes, mime);
    recordUpload(db, {
      memorialId: input.memorialId,
      assetId,
      blobKey: key,
      mime,
      byteSize: bytes.byteLength,
      originalFilename: item.filename,
      uploadedByParticipantId: input.participantId ?? null,
    });
    assetIds.push(assetId);
    tally.added += 1;
  }

  await deletePickerSession({
    accessToken: input.accessToken,
    sessionId: input.sessionId,
    ...fetchOptions,
  });

  return { tally, summary: importSummary(tally), assetIds, expiredFilenames };
}

function isMedia(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/');
}

/**
 * One photograph, with one retry.
 *
 * `baseUrl`s go stale about an hour after they are listed, and a long import
 * can outlive them. A single retry costs a second and rescues the case where
 * the first call was simply unlucky; a second failure is accepted as a loss and
 * reported honestly rather than failing the whole import.
 */
async function fetchBytes(input: ImportInput, item: PickedItem): Promise<Buffer | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await downloadPickedItem({
      accessToken: input.accessToken,
      item,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (result.ok) return result.bytes;
    if (result.reason === 'too-large') return undefined;
  }
  return undefined;
}
