/**
 * Turning an image part into base64 for the HTTP adapters.
 *
 * Only downsized, EXIF-stripped variants should ever reach this function — the
 * privacy posture is that what leaves the machine is the smallest thing that
 * can answer the question, never the family's original file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImagePart } from '../types';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

export function mimeForPath(filePath: string): string {
  return EXT_MIME[path.extname(filePath).toLowerCase()] ?? 'image/jpeg';
}

export async function readImagePart(part: ImagePart): Promise<{ base64: string; mime: string }> {
  if (part.source === 'base64') return { base64: part.base64, mime: part.mime };
  const buffer = await readFile(part.path);
  return { base64: buffer.toString('base64'), mime: part.mime ?? mimeForPath(part.path) };
}
