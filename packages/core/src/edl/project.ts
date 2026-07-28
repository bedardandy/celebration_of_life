/**
 * Where a slideshow lives between screens.
 *
 * A slideshow project is one row and one JSON document. Everything that can be
 * recomputed — the timeline, the two cuts, the length in minutes — is
 * recomputed, so there is exactly one thing that can be stale, and the version
 * number on it goes up every time the family changes anything. That number is
 * what the preview screen keys its player on: a new version means new pixels,
 * without a page reload and without a cache to get wrong.
 */
import {
  EdlSchema,
  type CutName,
  type Edl,
  type ResolvedTimeline,
  type Slide,
} from '@col/schemas';
import {
  and,
  desc,
  enqueue,
  eq,
  getById,
  insertOne,
  isNull,
  listAlive,
  mediaAssets,
  memorials,
  memoryNotes,
  slideshowProjects,
  updateById,
  type Db,
  type JobRow,
  type MediaAsset,
  type Memorial,
  type SlideshowProject,
} from '@col/db';
import { getPack } from '@col/tradition-packs';
import { currentDoc } from '../interview/store';
import { subjectOf } from '../interview/engine';
import type { EdlAssetInput, EdlBuildContext, EdlQuoteInput } from './generate';
import { DEFAULT_FAMILY_TARGET_SEC } from './generate';
import { SERVICE_TARGET_SEC, projectCut } from './timing';
import type { StoryStructure } from './shape';

/* -------------------------------------------------------------------------- */
/* the project row                                                             */
/* -------------------------------------------------------------------------- */

export function latestProject(db: Db, memorialId: string): SlideshowProject | undefined {
  return db
    .select()
    .from(slideshowProjects)
    .where(and(eq(slideshowProjects.memorialId, memorialId), isNull(slideshowProjects.deletedAt)))
    .orderBy(desc(slideshowProjects.createdAt))
    .limit(1)
    .all()[0];
}

/**
 * One project per memorial in practice, but found rather than assumed: a family
 * who starts the slideshow twice should land back in the one they already have,
 * with their edits, not in a fresh empty one.
 */
export function getOrCreateProject(
  db: Db,
  memorialId: string,
  values: { serviceTargetSec?: number; familyTargetSec?: number } = {},
): SlideshowProject {
  const existing = latestProject(db, memorialId);
  if (existing) return existing;
  return insertOne(db, slideshowProjects, {
    memorialId,
    serviceTargetSec: values.serviceTargetSec ?? SERVICE_TARGET_SEC,
    familyTargetSec: values.familyTargetSec ?? DEFAULT_FAMILY_TARGET_SEC,
    audioMode: 'sideloaded',
    status: 'draft',
  });
}

/** The stored EDL, or nothing if it has not been generated yet. */
export function projectEdl(project: SlideshowProject | undefined): Edl | undefined {
  if (!project?.edl) return undefined;
  const parsed = EdlSchema.safeParse(project.edl);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Write a new EDL and bump the version.
 *
 * Append-only would be tidier, but the thing a family needs to undo is a single
 * edit and every edit is already reversible on its own terms, so the version
 * exists to invalidate a player rather than to travel back in time.
 */
export function saveEdl(
  db: Db,
  projectId: string,
  edl: Edl,
  options: { status?: SlideshowProject['status'] } = {},
): SlideshowProject {
  const project = getById(db, slideshowProjects, projectId);
  if (!project) throw new Error(`no slideshow project ${projectId}`);
  const validated = EdlSchema.parse(edl);
  const updated = updateById(db, slideshowProjects, projectId, {
    edl: validated,
    edlVersion: project.edlVersion + 1,
    ...(options.status ? { status: options.status } : {}),
  });
  if (!updated) throw new Error(`slideshow project ${projectId} vanished mid-save`);
  return updated;
}

/** Kick off generation. The screen redirects to the preview and waits there. */
export function enqueueEdlJob(
  db: Db,
  memorialId: string,
  projectId: string,
  options: { regenerate?: boolean } = {},
): JobRow {
  return enqueue(
    db,
    {
      type: 'generate-edl',
      memorialId,
      projectId,
      regenerate: options.regenerate ?? false,
    },
    { memorialId, priority: 5 },
  );
}

/* -------------------------------------------------------------------------- */
/* what generation needs                                                       */
/* -------------------------------------------------------------------------- */

/** Photographs the family has said yes to, in the order the grid shows them. */
export function approvedAssets(db: Db, memorialId: string): MediaAsset[] {
  return listAlive(db, mediaAssets, eq(mediaAssets.memorialId, memorialId), 2_000)
    .filter((asset) => asset.curationState === 'approved' && asset.mime.startsWith('image/'))
    .sort(byEraThenCapture);
}

/** Oldest first, undated last, then by id so the order never wobbles. */
function byEraThenCapture(a: MediaAsset, b: MediaAsset): number {
  const left = a.capturedAt ?? Number.POSITIVE_INFINITY;
  const right = b.capturedAt ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function assetInputsFor(assets: readonly MediaAsset[]): EdlAssetInput[] {
  return assets.map((asset) => ({
    assetId: asset.id,
    caption: asset.caption,
    eraGuess: asset.eraGuess ?? asset.analysis?.eraGuess ?? null,
    suitability: asset.analysis?.slideSuitability ?? null,
    description: asset.analysis?.description ?? null,
    emotionalTone: asset.analysis?.emotionalTone ?? null,
    settingTags: asset.analysis?.settingTags ?? [],
    suggestedCaption: asset.analysis?.suggestedCaption ?? null,
    width: asset.width,
    height: asset.height,
  }));
}

/**
 * Everything a quote card is allowed to say.
 *
 * Two sources, both of them a real person's words that somebody has approved:
 * memory notes written by contributors, and anecdotes in the life story
 * document that the organiser has ticked. Nothing AI-drafted and unapproved
 * ever reaches this list — that is the whole point of it existing.
 */
export function approvedQuotes(db: Db, memorial: Memorial): EdlQuoteInput[] {
  const out: EdlQuoteInput[] = [];

  const notes = listAlive(db, memoryNotes, eq(memoryNotes.memorialId, memorial.id), 500)
    .filter((note) => note.approved && note.text.trim().length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const note of notes) {
    out.push({
      text: note.text.trim(),
      attribution: note.authorName?.trim() || 'Someone who loved them',
    });
  }

  const { doc } = currentDoc(db, memorial.id, subjectOf(memorial));
  for (const chapter of doc.chapters) {
    for (const anecdote of chapter.anecdotes) {
      if (!anecdote.approved) continue;
      const text = anecdote.text.trim();
      if (!text) continue;
      out.push({ text, attribution: `From ${memorial.decedentName}'s story` });
    }
  }

  // Two people can write the same sentence; a slideshow should not say it twice.
  const seen = new Set<string>();
  return out.filter((quote) => {
    const key = quote.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Placement guidance from the tradition pack, in the pack's own words, so the
 * model knows whether it is writing for a vigil, a reception or a shiva. There
 * is no `if (catholic)` anywhere in this product and this is why.
 */
export function traditionNotesFor(traditionSlug: string): string | undefined {
  const placement = getPack(traditionSlug).mediaPlacement[0];
  return placement ? `${placement.context}: ${placement.guidance}` : undefined;
}

export type BuildContextOptions = {
  structure?: StoryStructure;
  traditionNotes?: string;
};

/** Everything the generation call needs, gathered in one query pass. */
export function buildContext(
  db: Db,
  memorialId: string,
  projectId: string,
  options: BuildContextOptions = {},
): EdlBuildContext {
  const memorial = getById(db, memorials, memorialId);
  if (!memorial) throw new Error(`memorial ${memorialId} not found`);
  const project = getById(db, slideshowProjects, projectId);
  const { doc } = currentDoc(db, memorialId, subjectOf(memorial));
  const assets = approvedAssets(db, memorialId);

  return {
    projectId,
    subject: subjectOf(memorial),
    assets: assetInputsFor(assets),
    quotes: approvedQuotes(db, memorial),
    structure: options.structure ?? doc.structure,
    targetSec: project?.familyTargetSec ?? DEFAULT_FAMILY_TARGET_SEC,
    serviceTargetSec: project?.serviceTargetSec ?? SERVICE_TARGET_SEC,
    themeId: project?.themeId ?? 'quiet-linen',
    audioMode: project?.audioMode ?? 'sideloaded',
    storyChapters: doc.chapters.map((chapter) => ({
      title: chapter.title,
      ...(chapter.summary ? { summary: chapter.summary } : {}),
    })),
    themes: doc.themes,
    ...(doc.toneNotes ? { toneNotes: doc.toneNotes } : {}),
    ...(options.traditionNotes ? { traditionNotes: options.traditionNotes } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* what the preview screen shows                                               */
/* -------------------------------------------------------------------------- */

export type PreviewSlideRow = {
  slideId: string;
  slide: Slide;
  chapterId: string;
  chapterTitle: string;
  /** Position in the flat list, for "move up" and "move down". */
  index: number;
  startSec: number;
  durationSec: number;
  /** In this cut. A slide the service cut dropped still appears, marked. */
  inCut: boolean;
  omitted: boolean;
};

export type PreviewView = {
  timeline: ResolvedTimeline;
  rows: PreviewSlideRow[];
  /** Slides the family removed, so the screen can offer them back. */
  removed: PreviewSlideRow[];
};

/**
 * The preview screen's whole model: one resolved timeline for the player, and
 * one flat list of rows for the buttons underneath. Removed slides come back
 * separately rather than being lost, because "put it back" has to be findable
 * ten minutes later, not only while a toast is on screen.
 */
export function previewView(edl: Edl, cut: CutName): PreviewView {
  const timeline = projectCut(edl, cut);
  const placement = new Map(timeline.slides.map((slide) => [slide.slideId, slide]));
  const omitted = new Set(edl.omittedSlideIds);

  const rows: PreviewSlideRow[] = [];
  const removed: PreviewSlideRow[] = [];
  let index = 0;

  for (const chapter of edl.chapters) {
    for (const slideId of chapter.slideIds) {
      const slide = edl.slides[slideId];
      if (!slide) continue;
      const resolved = placement.get(slideId);
      const row: PreviewSlideRow = {
        slideId,
        slide,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        index: omitted.has(slideId) ? -1 : index,
        startSec: resolved?.startSec ?? 0,
        durationSec: resolved?.durationSec ?? slide.durationSec,
        inCut: resolved !== undefined,
        omitted: omitted.has(slideId),
      };
      if (row.omitted) removed.push(row);
      else {
        rows.push(row);
        index += 1;
      }
    }
  }

  return { timeline, rows, removed };
}
