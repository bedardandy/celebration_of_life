/**
 * Faces, as data.
 *
 * A face here is three things: where it is in the picture, a vector that says
 * which faces look like each other, and how confident the detector was. None of
 * it ever leaves the machine it was computed on — that promise is the reason
 * this feature exists at all — so these shapes only have to satisfy our own
 * database boundary, never an API.
 *
 * The embedding is stored as plain numbers rather than packed bytes because it
 * is small (128–512 floats per face), because a JSON column is portable to
 * Postgres unchanged, and because a family's face vectors should be readable by
 * whoever is deleting them.
 */
import { z } from 'zod';

/** Where a face sits in the photograph, in 0..1 of the picture's own size. */
export const FaceBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .strict();
export type FaceBox = z.infer<typeof FaceBoxSchema>;

/** A face descriptor. Length depends on the model; the maths does not care. */
export const FaceEmbeddingSchema = z.array(z.number()).min(2).max(2048);
export type FaceEmbedding = z.infer<typeof FaceEmbeddingSchema>;

export const FaceDetectionSchema = z
  .object({
    box: FaceBoxSchema,
    embedding: FaceEmbeddingSchema,
    /** 0..1 detector confidence, moderated by how big and how sharp the face is. */
    quality: z.number().min(0).max(1),
  })
  .strict();
export type FaceDetectionRecord = z.infer<typeof FaceDetectionSchema>;
