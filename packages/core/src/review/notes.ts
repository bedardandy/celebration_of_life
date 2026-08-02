/**
 * What the family said about the draft.
 *
 * The organiser sends the viewing link to eleven people, and three of them
 * notice something: the photograph at 1:23 is Margaret, not Ruth; his mother's
 * name is spelled wrong on the last card; there is a lovely one from the boat
 * that is missing. Until now the only way to say that was a text message at
 * midnight, which the organiser then had to hold in their head.
 *
 * So a note is a small, plain thing: who wrote it, what they said, and — if
 * they pressed the button — where in the video they were. Two rules shape
 * everything here:
 *
 *  - a note is for the organiser only. It is never shown to another viewer,
 *    and the screen that collects it says so before anybody types.
 *  - the raw timecode is the truth. We also resolve it to a slide at write
 *    time, so the organiser reads "the photo of the lake" instead of a number,
 *    but the slideshow gets edited afterwards and that reading can go stale.
 *    The number cannot.
 */
import {
  and,
  desc,
  eq,
  getById,
  insertOne,
  listWhere,
  memorials,
  participants,
  renderJobs,
  reviewNotes,
  slideshowProjects,
  updateById,
  type Db,
  type ReviewNote,
} from '@col/db';
import type { CutName, ResolvedTimeline, Slide } from '@col/schemas';
import { projectEdl } from '../edl/project';
import { projectCut } from '../edl/timing';

/** Long enough for a paragraph, short enough that nobody writes an essay. */
export const MAX_NOTE_CHARS = 800;

/** A first name, not a biography. */
export const MAX_AUTHOR_NAME_CHARS = 80;

/**
 * A gentle ceiling per memorial, so a link that ends up somewhere it should not
 * be cannot fill a family's screen. Fifty is far more than any real family
 * leaves, and the fifty they left are all kept.
 */
export const MAX_WATCH_NOTES_PER_MEMORIAL = 50;

export type ReviewNoteStatus = ReviewNote['status'];

/* -------------------------------------------------------------------------- */
/* what a person typed                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Plain text, and only plain text.
 *
 * Notes are written by strangers to the product holding a capability URL, and
 * they are read back on the organiser's screen. So markup comes out, control
 * characters come out, runaway whitespace is collapsed, and what is left is
 * exactly the sentence somebody meant to write.
 */
export function cleanNoteText(raw: string, max: number = MAX_NOTE_CHARS): string {
  // Script and style elements go with their contents; a <br> was a line break
  // to whoever typed it; every other tag simply disappears, leaving the words
  // either side of it joined as they were written.
  const withoutScripts = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*/gi, ' ');
  const withoutTags = withoutScripts.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  // Newlines survive: two thoughts should stay two lines.
  // eslint-disable-next-line no-control-regex
  const withoutControl = withoutTags.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  return withoutControl
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function cleanAuthorName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = cleanNoteText(raw, MAX_AUTHOR_NAME_CHARS).replace(/\s+/g, ' ');
  return cleaned || null;
}

/* -------------------------------------------------------------------------- */
/* where in the video                                                          */
/* -------------------------------------------------------------------------- */

/** "1:23" — the only way a time in a video is ever written on screen. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** The slide on screen at this moment, or nothing if the time is past the end. */
export function slideIdAt(timeline: ResolvedTimeline, ms: number): string | undefined {
  const seconds = ms / 1000;
  let best: string | undefined;
  for (const slide of timeline.slides) {
    if (slide.startSec <= seconds + 1e-6) best = slide.slideId;
    if (slide.startSec > seconds) break;
  }
  const last = timeline.slides[timeline.slides.length - 1];
  if (last && seconds > last.startSec + last.durationSec + 1) return undefined;
  return best;
}

/** The timeline a viewer was actually watching, when one can be worked out. */
export function watchedTimeline(
  db: Db,
  memorialId: string,
  renderJobId: string | null | undefined,
): ResolvedTimeline | undefined {
  const job = renderJobId ? getById(db, renderJobs, renderJobId) : undefined;
  if (job && job.memorialId !== memorialId) return undefined;

  const project = job
    ? getById(db, slideshowProjects, job.projectId)
    : listWhere(db, slideshowProjects, eq(slideshowProjects.memorialId, memorialId))
        .filter((row) => row.deletedAt == null)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!project || project.memorialId !== memorialId) return undefined;

  const edl = projectEdl(project);
  if (!edl) return undefined;
  const cut: CutName = job?.cut ?? 'service';
  return projectCut(edl, cut);
}

/* -------------------------------------------------------------------------- */
/* writing one down                                                            */
/* -------------------------------------------------------------------------- */

export type AddReviewNoteInput = {
  memorialId: string;
  body: string;
  authorName?: string | null;
  /** Which draft they were watching, when we know. */
  renderJobId?: string | null;
  timecodeMs?: number | null;
  createdVia?: ReviewNote['createdVia'];
};

export type AddReviewNoteResult =
  { ok: true; note: ReviewNote } | { ok: false; reason: 'empty' | 'too-many' | 'gone' };

export function addReviewNote(db: Db, input: AddReviewNoteInput): AddReviewNoteResult {
  const memorial = getById(db, memorials, input.memorialId);
  if (!memorial || memorial.deletedAt != null) return { ok: false, reason: 'gone' };

  const body = cleanNoteText(input.body);
  if (!body) return { ok: false, reason: 'empty' };

  const createdVia = input.createdVia ?? 'watch';
  if (
    createdVia === 'watch' &&
    countWatchNotes(db, input.memorialId) >= MAX_WATCH_NOTES_PER_MEMORIAL
  ) {
    return { ok: false, reason: 'too-many' };
  }

  const timecodeMs =
    input.timecodeMs == null || !Number.isFinite(input.timecodeMs) || input.timecodeMs < 0
      ? null
      : Math.round(input.timecodeMs);

  const timeline =
    timecodeMs == null ? undefined : watchedTimeline(db, input.memorialId, input.renderJobId);
  const slideId = timeline && timecodeMs != null ? (slideIdAt(timeline, timecodeMs) ?? null) : null;

  const note = insertOne(db, reviewNotes, {
    memorialId: input.memorialId,
    renderJobId: input.renderJobId ?? null,
    authorName: cleanAuthorName(input.authorName),
    body,
    timecodeMs,
    slideId,
    status: 'open',
    createdVia,
  });
  return { ok: true, note };
}

function countWatchNotes(db: Db, memorialId: string): number {
  return listWhere(
    db,
    reviewNotes,
    and(eq(reviewNotes.memorialId, memorialId), eq(reviewNotes.createdVia, 'watch')),
    MAX_WATCH_NOTES_PER_MEMORIAL + 1,
  ).length;
}

/* -------------------------------------------------------------------------- */
/* reading them back                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Newest first: the thing somebody said ten minutes ago matters most.
 *
 * Two notes can land in the same millisecond — two people watching the same
 * link on the same evening — so the id breaks the tie. It is a uuidv7, which
 * sorts the same way time does, and it means the list never wobbles between
 * two loads of the same page.
 */
export function listReviewNotes(db: Db, memorialId: string, limit = 200): ReviewNote[] {
  return db
    .select()
    .from(reviewNotes)
    .where(eq(reviewNotes.memorialId, memorialId))
    .orderBy(desc(reviewNotes.createdAt), desc(reviewNotes.id))
    .limit(limit)
    .all();
}

/** How many are still waiting on the organiser. The only number worth showing. */
export function countOpenReviewNotes(db: Db, memorialId: string): number {
  return listWhere(
    db,
    reviewNotes,
    and(eq(reviewNotes.memorialId, memorialId), eq(reviewNotes.status, 'open')),
    500,
  ).length;
}

export type SetReviewNoteStatusResult = {
  note: ReviewNote;
  /** What it was before, so Undo can put it back exactly. */
  previous: ReviewNoteStatus;
  /** Plain sentence for the Undo toast. */
  message: string;
};

const STATUS_MESSAGE: Record<ReviewNoteStatus, string> = {
  open: 'Put back.',
  done: 'Marked as done.',
  dismissed: 'Put aside.',
};

export function setReviewNoteStatus(
  db: Db,
  memorialId: string,
  noteId: string,
  status: ReviewNoteStatus,
): SetReviewNoteStatusResult | undefined {
  const existing = getById(db, reviewNotes, noteId);
  if (!existing || existing.memorialId !== memorialId) return undefined;
  const updated = updateById(db, reviewNotes, noteId, { status });
  if (!updated) return undefined;
  return { note: updated, previous: existing.status, message: STATUS_MESSAGE[status] };
}

/* -------------------------------------------------------------------------- */
/* what the organiser's screen shows                                           */
/* -------------------------------------------------------------------------- */

export type ReviewNoteView = {
  note: ReviewNote;
  /** Their first name, or a kind stand-in. */
  authorLabel: string;
  /** "at 1:23 — the photo of the lake", or just "at 1:23". */
  whereLine?: string;
  /** Straight to that slide on the preview screen, when we can point at one. */
  href?: string;
  /** "yesterday", "3 days ago". Never a timestamp. */
  ageLabel: string;
};

/** A slide, described the way a person would say it out loud. */
export function describeSlideBriefly(slide: Slide): string {
  switch (slide.kind) {
    case 'photo':
      return slide.caption?.text
        ? `the photo of ${lowerFirst(slide.caption.text)}`
        : 'a photograph';
    case 'quote':
      return `the memory from ${slide.attribution}`;
    case 'title':
      return 'the opening';
    case 'closing':
      return 'the last card';
  }
}

function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/[.!?]+$/, '');
  const first = trimmed.slice(0, 1);
  // "Dollymount" stays capitalised; "The lake" becomes "the lake".
  return first === first.toUpperCase() && trimmed.slice(1, 2) === trimmed.slice(1, 2).toUpperCase()
    ? trimmed
    : first.toLowerCase() + trimmed.slice(1);
}

/**
 * "yesterday", not "18 hours ago" and never a date.
 *
 * A person going through notes wants to know which are new, and that is all.
 */
export function describeAge(createdAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'a week ago' : `${weeks} weeks ago`;
}

export function reviewNoteViews(
  db: Db,
  memorialId: string,
  options: { now?: number } = {},
): ReviewNoteView[] {
  const now = options.now ?? Date.now();
  const notes = listReviewNotes(db, memorialId);
  const project = listWhere(db, slideshowProjects, eq(slideshowProjects.memorialId, memorialId))
    .filter((row) => row.deletedAt == null)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const edl = project ? projectEdl(project) : undefined;

  return notes.map((note) => {
    const slide = note.slideId ? edl?.slides[note.slideId] : undefined;
    const time = note.timecodeMs == null ? undefined : `at ${formatTimecode(note.timecodeMs)}`;
    const where = slide ? describeSlideBriefly(slide) : undefined;
    const whereLine = time && where ? `${time} — ${where}` : (time ?? where);

    return {
      note,
      authorLabel: note.authorName?.trim() || 'Someone the family sent the link to',
      ...(whereLine ? { whereLine } : {}),
      ...(slide && note.slideId ? { href: `/m/${memorialId}/preview#slide-${note.slideId}` } : {}),
      ageLabel: describeAge(note.createdAt, now),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* words                                                                       */
/* -------------------------------------------------------------------------- */

/** The prompt under the video. Uses the organiser's first name, if we have it. */
export function noteInvitation(organizerName: string | null | undefined): string {
  const first = firstNameOf(organizerName);
  return first
    ? `Spotted something, or have a thought? Tell ${first}.`
    : 'Spotted something, or have a thought? Tell the family.';
}

export function notePrivacyLine(organizerName: string | null | undefined): string {
  const first = firstNameOf(organizerName);
  return first ? `Only ${first} will see this.` : 'Only the family will see this.';
}

export function firstNameOf(name: string | null | undefined): string | undefined {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first || undefined;
}

/**
 * Whose name goes on the invitation: the organiser who started the memorial.
 * Where there are several — a family who share the work — the first one is the
 * one everybody else was told to talk to.
 */
export function organizerDisplayName(db: Db, memorialId: string): string | undefined {
  return listWhere(
    db,
    participants,
    and(eq(participants.memorialId, memorialId), eq(participants.role, 'organizer')),
  )
    .filter((row) => row.revokedAt == null)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
    ?.displayName?.trim();
}

export const NOTE_THANKS = 'Thank you. That has gone to the family.';

export const REVIEW_EMPTY_STATE =
  'No notes yet. When family watch the video from your shared link, they can leave a thought here.';
