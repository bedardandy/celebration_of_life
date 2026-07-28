/**
 * The three files this product makes.
 *
 * Not "quality settings" — three different jobs:
 *
 *  draft360   a family checking the order of the photographs and the spelling
 *             of a name. Small and fast, because the point is the second look,
 *             not the pixels.
 *  final1080  the delivery of record. 1080p30 H.264 High in yuv420p, which is
 *             the format every venue laptop, DVD player and smart TV made in
 *             the last fifteen years will play.
 *  backup720  the same video for a machine that stutters on 1080p. Every
 *             funeral home has one.
 *
 * The CRFs are chosen for content that is almost entirely still photographs
 * with slow moves: 19 is visually transparent on that material, and 30 is
 * perfectly legible at 640×360 while keeping a draft under a few megabytes.
 */
import type { RenderPreset } from '@col/schemas';

export type RenderPresetSpec = {
  id: RenderPreset;
  width: number;
  height: number;
  fps: number;
  crf: number;
  /** x264 preset. Slower on the final because it is rendered once and watched often. */
  x264Preset: 'ultrafast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
  /** How many frames Remotion renders in parallel. */
  concurrency?: number;
  label: string;
};

export const RENDER_PRESETS: Record<RenderPreset, RenderPresetSpec> = {
  draft360: {
    id: 'draft360',
    width: 640,
    height: 360,
    fps: 30,
    crf: 30,
    x264Preset: 'veryfast',
    label: 'Quick preview',
  },
  final1080: {
    id: 'final1080',
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 19,
    x264Preset: 'medium',
    label: 'Final, 1080p',
  },
  backup720: {
    id: 'backup720',
    width: 1280,
    height: 720,
    fps: 30,
    crf: 21,
    x264Preset: 'medium',
    label: 'Backup, 720p',
  },
};

export function renderPreset(id: RenderPreset): RenderPresetSpec {
  return RENDER_PRESETS[id];
}
