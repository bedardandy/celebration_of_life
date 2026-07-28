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

export const JobPayloadSchema = z.discriminatedUnion('type', [
  NoopPayloadSchema,
  IngestAssetPayloadSchema,
  AnalyzePhotoBatchPayloadSchema,
  GenerateEdlPayloadSchema,
  RenderPayloadSchema,
  PurgeBlobsPayloadSchema,
  SendEmailPayloadSchema,
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
