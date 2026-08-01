import { z } from 'zod';
import { CutNameSchema, IdSchema, RenderPresetSchema } from './common';

export const JOB_TYPES = [
  'noop',
  'ingest-asset',
  'analyze-photo-batch',
  'generate-edl',
  'render',
  'purge-blobs',
  'send-email',
  'import-google-photos',
  'detect-faces',
  'enhance-asset',
] as const;

export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

/** Health-check / plumbing job. The only handler implemented in Phase 0. */
export const NoopPayloadSchema = z
  .object({
    type: z.literal('noop'),
    sleepMs: z.number().int().min(0).max(60_000).default(100),
    note: z.string().max(200).optional(),
  })
  .strict();

/** Normalise one upload: HEIC→JPEG, EXIF, variants, phash, blur score. */
export const IngestAssetPayloadSchema = z
  .object({
    type: z.literal('ingest-asset'),
    memorialId: IdSchema,
    assetId: IdSchema,
    blobKey: z.string().min(1),
  })
  .strict();

export const AnalyzePhotoBatchPayloadSchema = z
  .object({
    type: z.literal('analyze-photo-batch'),
    memorialId: IdSchema,
    assetIds: z.array(IdSchema).min(1).max(200),
  })
  .strict();

export const GenerateEdlPayloadSchema = z
  .object({
    type: z.literal('generate-edl'),
    memorialId: IdSchema,
    projectId: IdSchema,
    regenerate: z.boolean().default(false),
  })
  .strict();

export const RenderPayloadSchema = z
  .object({
    type: z.literal('render'),
    memorialId: IdSchema,
    projectId: IdSchema,
    renderJobId: IdSchema,
    cut: CutNameSchema,
    preset: RenderPresetSchema,
  })
  .strict();

/** Hard delete is real: purge every blob under a memorial's key prefix. */
export const PurgeBlobsPayloadSchema = z
  .object({
    type: z.literal('purge-blobs'),
    memorialId: IdSchema,
    prefix: z.string().min(1),
  })
  .strict();

export const SendEmailPayloadSchema = z
  .object({
    type: z.literal('send-email'),
    to: z.string().email(),
    subject: z.string().min(1).max(300),
    template: z.string().min(1).max(80),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * Bring photographs across from Google Photos.
 *
 * The access token is not here in the clear and is never stored in a column of
 * its own: `sealedToken` is an AES-GCM envelope opened with a key derived from
 * `SESSION_SECRET`, and the handler blanks it the moment the import finishes.
 * The tradeoff — an encrypted, short-lived credential resting briefly in a job
 * row — is written down in docs/google-photos.md.
 */
export const ImportGooglePhotosPayloadSchema = z
  .object({
    type: z.literal('import-google-photos'),
    memorialId: IdSchema,
    /** The Picker session the person is choosing photographs in. */
    sessionId: z.string().min(1).max(200),
    sealedToken: z.string().min(1).max(4_000),
    /** The organizer the photographs are attributed to. */
    participantId: IdSchema.optional(),
  })
  .strict();

/**
 * Find the same faces across a memorial's photographs. Entirely local: no
 * payload here ever crosses a network, and the job is skipped rather than
 * failed when no face engine is installed.
 */
export const DetectFacesPayloadSchema = z
  .object({
    type: z.literal('detect-faces'),
    memorialId: IdSchema,
    /** Omitted means "every photograph that is ready and not yet looked at". */
    assetIds: z.array(IdSchema).max(2_000).optional(),
    /** Look again at photographs that already have faces recorded. */
    redo: z.boolean().default(false),
  })
  .strict();

/** Make the opt-in gently-restored copy of one photograph. */
export const EnhanceAssetPayloadSchema = z
  .object({
    type: z.literal('enhance-asset'),
    memorialId: IdSchema,
    assetId: IdSchema,
  })
  .strict();

export const JobPayloadSchema = z.discriminatedUnion('type', [
  NoopPayloadSchema,
  IngestAssetPayloadSchema,
  AnalyzePhotoBatchPayloadSchema,
  GenerateEdlPayloadSchema,
  RenderPayloadSchema,
  PurgeBlobsPayloadSchema,
  SendEmailPayloadSchema,
  ImportGooglePhotosPayloadSchema,
  DetectFacesPayloadSchema,
  EnhanceAssetPayloadSchema,
]);
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export type JobPayloadFor<T extends JobType> = Extract<JobPayload, { type: T }>;

export const JobStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Per-type schema map, handy for validating at the DB boundary. */
export const JobPayloadSchemas = {
  noop: NoopPayloadSchema,
  'ingest-asset': IngestAssetPayloadSchema,
  'analyze-photo-batch': AnalyzePhotoBatchPayloadSchema,
  'generate-edl': GenerateEdlPayloadSchema,
  render: RenderPayloadSchema,
  'purge-blobs': PurgeBlobsPayloadSchema,
  'send-email': SendEmailPayloadSchema,
  'import-google-photos': ImportGooglePhotosPayloadSchema,
  'detect-faces': DetectFacesPayloadSchema,
  'enhance-asset': EnhanceAssetPayloadSchema,
} as const;

/**
 * Parse a payload that came out of the `jobs.payload` text column. Job rows
 * carry `type` separately, so we cross-check the two agree.
 */
export function parseJobPayload(type: string, payload: unknown): JobPayload {
  const parsed = JobPayloadSchema.parse(payload);
  if (parsed.type !== type) {
    throw new Error(`job payload type "${parsed.type}" does not match row type "${type}"`);
  }
  return parsed;
}
