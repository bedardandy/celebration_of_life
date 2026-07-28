'use server';

/**
 * The music decisions, made.
 *
 * Every one of these writes the choice and then re-times the slideshow, because
 * choosing music in this product is not a setting — it changes where the slides
 * change. The redirect afterwards goes forward, to the preview or to delivery,
 * never back to the screen the person just finished with.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OWNERSHIP_STATEMENT,
  chooseClearedTrack,
  chooseSideloaded,
  getOrCreateProject,
  latestProject,
  recordFamilyTrack,
} from '@col/core';
import { beatGridFromBpm, estimateTempo, isPlausibleBpm, mediaDurationSec } from '@col/media';
import { getBlobStore } from '@col/storage';
import { getById, musicTracks } from '@col/db';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/** How long a side-loaded grid is generated for when nobody said. */
const DEFAULT_SIDELOADED_SEC = 360;

function refresh(memorialId: string): void {
  revalidatePath(`/m/${memorialId}/music`);
  revalidatePath(`/m/${memorialId}/preview`);
  revalidatePath(`/m/${memorialId}/deliver`);
  revalidatePath(`/m/${memorialId}`);
}

/**
 * The mode decision: two cards, one tap.
 *
 * It is stored on the project immediately rather than held until the second
 * screen, so somebody who closes the tab between the two questions comes back
 * to the second one.
 */
export async function chooseModeAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const mode = String(formData.get('mode') ?? '') === 'sideloaded' ? 'sideloaded' : 'cleared';
  await requireOrganizer(memorialId);

  getOrCreateProject(db(), memorialId);
  refresh(memorialId);
  redirect(`/m/${memorialId}/music/${mode === 'cleared' ? 'included' : 'their-song'}`);
}

/** Pick a track from the library — the video can then be shared anywhere. */
export async function chooseTrackAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const trackId = String(formData.get('trackId') ?? '');
  await requireOrganizer(memorialId);

  const project = getOrCreateProject(db(), memorialId);
  const track = getById(db(), musicTracks, trackId);
  // A track id from another memorial's family upload is not choosable here.
  if (
    !track ||
    (track.licenseKind === 'family-supplied' && !belongsTo(track.blobKey, memorialId))
  ) {
    redirect(`/m/${memorialId}/music/included?problem=unknown-track`);
  }

  chooseClearedTrack(db(), { memorialId, projectId: project.id, trackId });
  refresh(memorialId);
  redirect(`/m/${memorialId}/music/chosen`);
}

/**
 * Their song, played live, video silent.
 *
 * The tempo is optional and always has been: a family who knows the song is
 * "slow" and nothing else still gets a video, just one whose slide changes are
 * not aligned to anything.
 */
export async function chooseSideloadedAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const artist = String(formData.get('artist') ?? '').trim();
  const bpmRaw = Number(formData.get('bpm'));
  await requireOrganizer(memorialId);

  if (title.length === 0) {
    redirect(`/m/${memorialId}/music/their-song?problem=no-title`);
  }

  const project = getOrCreateProject(db(), memorialId);
  const bpm = isPlausibleBpm(bpmRaw) ? bpmRaw : undefined;
  const durationSec = Number(formData.get('songSec')) || DEFAULT_SIDELOADED_SEC;

  chooseSideloaded(db(), {
    memorialId,
    projectId: project.id,
    title,
    ...(artist ? { artist } : {}),
    ...(bpm ? { bpm, beatGrid: beatGridFromBpm(bpm, durationSec) } : {}),
  });

  refresh(memorialId);
  redirect(`/m/${memorialId}/music/chosen`);
}

/**
 * A recording the family owns — Grandpa at the piano, the choir in 1998.
 *
 * Three things happen and all three matter: the file is stored under this
 * memorial's own prefix so a hard delete really removes it, the tempo is
 * estimated so the slides can be cut to it, and the sentence the organiser
 * ticked is recorded verbatim against the track. We take their word for it —
 * and we write down exactly which word.
 */
export async function uploadOwnAudioAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const { memorial } = await requireOrganizer(memorialId);

  const file = formData.get('audio');
  const confirmed = formData.get('owned') != null;
  const title = String(formData.get('title') ?? '').trim();

  if (!(file instanceof File) || file.size === 0) {
    redirect(`/m/${memorialId}/music/upload?problem=no-file`);
  }
  if (!confirmed) {
    redirect(`/m/${memorialId}/music/upload?problem=not-confirmed`);
  }

  const extension = extensionFor(file.name, file.type);
  const blobKey = `memorial/${memorialId}/music/${randomUUID()}.${extension}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await getBlobStore().put(blobKey, bytes, file.type || 'audio/mpeg');

  // ffmpeg needs a path. A local store hands one back; anything else (S3, one
  // day) gets a scratch copy rather than a silent loss of the beat grid.
  const stored = getBlobStore().getPath?.(blobKey);
  const scratch =
    stored ?? path.join(await mkdtemp(path.join(tmpdir(), 'col-audio-')), `in.${extension}`);
  if (!stored) await writeFile(scratch, bytes);

  let durationSec = 0;
  let bpm = 72;
  let beatGrid = beatGridFromBpm(bpm, DEFAULT_SIDELOADED_SEC);

  try {
    durationSec = (await mediaDurationSec(scratch)) ?? 0;
    if (durationSec > 0) {
      // On this machine, not anyone else's: the recording never leaves.
      const tempo = await estimateTempo(scratch, durationSec);
      bpm = tempo.bpm;
      beatGrid = tempo.beatGrid;
    }
  } catch {
    // An unreadable file is a thing to tell the family about, not to throw.
    durationSec = 0;
  } finally {
    if (!stored) await rm(path.dirname(scratch), { recursive: true, force: true });
  }

  if (durationSec <= 0) {
    // The upload stays in the store only if it is usable; a file we cannot read
    // is a file we have no reason to keep.
    await getBlobStore().delete(blobKey);
    redirect(`/m/${memorialId}/music/upload?problem=unreadable`);
  }

  const track = recordFamilyTrack(db(), {
    memorialId,
    title: title || file.name.replace(/\.[^.]+$/, '') || `A recording for ${memorial.decedentName}`,
    blobKey,
    durationSec,
    bpm,
    beatGrid,
    ownershipStatement: OWNERSHIP_STATEMENT,
  });

  const project = getOrCreateProject(db(), memorialId);
  chooseClearedTrack(db(), { memorialId, projectId: project.id, trackId: track.id });

  refresh(memorialId);
  redirect(`/m/${memorialId}/music/chosen`);
}

/** Change your mind: back to the two cards, nothing lost. */
export async function reopenMusicAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);
  latestProject(db(), memorialId);
  refresh(memorialId);
  redirect(`/m/${memorialId}/music`);
}

function belongsTo(blobKey: string | null, memorialId: string): boolean {
  return blobKey?.startsWith(`memorial/${memorialId}/`) === true;
}

function extensionFor(filename: string, mime: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(filename)?.[1]?.toLowerCase();
  if (fromName && /^(mp3|m4a|aac|wav|flac|ogg|opus|aiff|aif|wma)$/.test(fromName)) return fromName;
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  return 'm4a';
}
