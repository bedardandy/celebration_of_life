/**
 * Applying an interview turn to the life-story document.
 *
 * Pure, on purpose. This is the function that decides what happens to a
 * family's account of a person's life, so it has no database, no clock and no
 * randomness in it — the caller supplies id generation — and every rule below
 * is a test rather than a hope.
 *
 * The rules, in order of how much they matter:
 *
 *  1. Nothing a person approved is ever removed or reworded by a patch. The
 *     interview is a drafting partner; it does not get to edit the family.
 *  2. Nothing is deleted at all. `DocPatch` has no remove verb, and merges only
 *     ever add or fill in blanks.
 *  3. An omitted field means "leave it alone", not "set it to empty". A turn
 *     about a garden must not blank a childhood.
 *  4. Anecdotes arrive `approved: false` and stay that way until someone says
 *     otherwise, somewhere else.
 */
import type {
  Anecdote,
  ChapterPatch,
  DocPatch,
  LifeStoryChapter,
  LifeStoryDocument,
} from '@col/schemas';

export type ApplyDocPatchOptions = {
  /** Id factory for new chapters and anecdotes. Injected so results are stable. */
  newId: () => string;
  /**
   * Chapter that loose additions (open questions, anecdotes with no chapterId)
   * belong to. Defaults to the first chapter the patch touches, then the last
   * chapter in the document.
   */
  targetChapterId?: string;
  /** Title given to the chapter created to hold an anecdote with nowhere to go. */
  fallbackChapterTitle?: string;
};

export type ApplyDocPatchResult = {
  doc: LifeStoryDocument;
  /** True when anything actually changed — used to skip an empty doc version. */
  changed: boolean;
  /** Chapter ids created by this patch. */
  createdChapterIds: string[];
  /** Anecdote ids added by this patch. All of them start unapproved. */
  addedAnecdoteIds: string[];
};

export const DEFAULT_FALLBACK_CHAPTER_TITLE = 'Their life';

export function applyDocPatch(
  doc: LifeStoryDocument,
  patch: DocPatch,
  options: ApplyDocPatchOptions,
): ApplyDocPatchResult {
  const chapters = doc.chapters.map(cloneChapter);
  const createdChapterIds: string[] = [];
  const addedAnecdoteIds: string[] = [];
  let changed = false;

  for (const upsert of patch.chapterUpserts) {
    const index = chapters.findIndex((chapter) => chapter.id === upsert.id);
    if (index === -1) {
      chapters.push(chapterFromPatch(upsert));
      createdChapterIds.push(upsert.id);
      changed = true;
      continue;
    }
    if (mergeChapter(chapters[index] as LifeStoryChapter, upsert)) changed = true;
  }

  const themes = [...doc.themes];
  for (const theme of patch.themeAdds) {
    if (containsFold(themes, theme)) continue;
    themes.push(theme.trim());
    changed = true;
  }

  // Where loose additions land. Resolved once, after chapter upserts, so a
  // chapter created by this same patch can be the target.
  const preferredId =
    options.targetChapterId ?? patch.chapterUpserts[0]?.id ?? chapters[chapters.length - 1]?.id;

  if (patch.openQuestionAdds.length > 0) {
    const target = chapters.find((chapter) => chapter.id === preferredId);
    // Open questions are the interview's own notes, not family content: with no
    // chapter to hold them, dropping them loses nothing anyone said.
    if (target) {
      for (const question of patch.openQuestionAdds) {
        if (containsFold(target.openQuestions, question)) continue;
        target.openQuestions.push(question.trim());
        changed = true;
      }
    }
  }

  for (const add of patch.anecdoteAdds) {
    // An anecdote is somebody's words. It always gets somewhere to live, even
    // if that means inventing a chapter for it.
    let target = chapters.find((chapter) => chapter.id === (add.chapterId ?? preferredId));
    if (!target) {
      const id = add.chapterId ?? options.newId();
      target = {
        id,
        title: options.fallbackChapterTitle ?? DEFAULT_FALLBACK_CHAPTER_TITLE,
        era: {},
        summary: '',
        anecdotes: [],
        people: [],
        openQuestions: [],
      };
      chapters.push(target);
      createdChapterIds.push(id);
      changed = true;
    }
    if (
      containsFold(
        target.anecdotes.map((a) => a.text),
        add.text,
      )
    )
      continue;
    const anecdote: Anecdote = {
      id: options.newId(),
      text: add.text.trim(),
      source: add.source,
      // Never true here. Approval is a separate, deliberate act by a person.
      approved: false,
    };
    target.anecdotes.push(anecdote);
    addedAnecdoteIds.push(anecdote.id);
    changed = true;
  }

  return {
    doc: changed ? { ...doc, chapters, themes } : doc,
    changed,
    createdChapterIds,
    addedAnecdoteIds,
  };
}

/* -------------------------------------------------------------------------- */

function cloneChapter(chapter: LifeStoryChapter): LifeStoryChapter {
  return {
    ...chapter,
    era: { ...chapter.era },
    anecdotes: chapter.anecdotes.map((anecdote) => ({ ...anecdote })),
    people: [...chapter.people],
    openQuestions: [...chapter.openQuestions],
  };
}

function chapterFromPatch(patch: ChapterPatch): LifeStoryChapter {
  return {
    id: patch.id,
    title: patch.title?.trim() || titleFromId(patch.id),
    era: patch.era ? { ...patch.era } : {},
    summary: patch.summary?.trim() ?? '',
    anecdotes: [],
    people: dedupeFold(patch.people ?? []),
    openQuestions: dedupeFold(patch.openQuestions ?? []),
  };
}

/** `early-years` → `Early years`. Only ever a fallback for a missing title. */
export function titleFromId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return 'Untitled chapter';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Merge in place on a cloned chapter. Returns whether anything actually moved. */
function mergeChapter(chapter: LifeStoryChapter, patch: ChapterPatch): boolean {
  let changed = false;

  const title = patch.title?.trim();
  if (title && title !== chapter.title) {
    chapter.title = title;
    changed = true;
  }

  if (patch.era) {
    for (const key of ['from', 'to'] as const) {
      const value = patch.era[key];
      if (value !== undefined && chapter.era[key] !== value) {
        chapter.era[key] = value;
        changed = true;
      }
    }
  }

  const summary = patch.summary?.trim();
  // A longer summary is an expansion; a shorter one is usually the model
  // forgetting what it was told last time. Keep the fuller account.
  if (summary && summary !== chapter.summary && summary.length >= chapter.summary.length) {
    chapter.summary = summary;
    changed = true;
  }

  for (const person of patch.people ?? []) {
    if (containsFold(chapter.people, person)) continue;
    chapter.people.push(person.trim());
    changed = true;
  }
  for (const question of patch.openQuestions ?? []) {
    if (containsFold(chapter.openQuestions, question)) continue;
    chapter.openQuestions.push(question.trim());
    changed = true;
  }

  return changed;
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function fold(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function containsFold(list: readonly string[], value: string): boolean {
  const needle = fold(value);
  if (needle.length === 0) return true;
  return list.some((item) => fold(item) === needle);
}

function dedupeFold(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (containsFold(out, value)) continue;
    out.push(value.trim());
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* organizer edits                                                             */
/* -------------------------------------------------------------------------- */

/** A blank document for someone we have only a name for. */
export function emptyLifeStoryDocument(subject: {
  fullName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
}): LifeStoryDocument {
  return {
    subject: {
      fullName: subject.fullName,
      ...(subject.knownAs ? { knownAs: subject.knownAs } : {}),
      ...(subject.birthYear ? { birthYear: subject.birthYear } : {}),
      ...(subject.deathYear ? { deathYear: subject.deathYear } : {}),
    },
    structure: 'chrono',
    chapters: [],
    themes: [],
    toneNotes: '',
    coveragePhotoGaps: [],
  };
}

export type AnecdoteRef = { chapterId: string; anecdoteId: string };

export function findAnecdote(
  doc: LifeStoryDocument,
  ref: AnecdoteRef,
): { chapter: LifeStoryChapter; anecdote: Anecdote } | undefined {
  const chapter = doc.chapters.find((c) => c.id === ref.chapterId);
  const anecdote = chapter?.anecdotes.find((a) => a.id === ref.anecdoteId);
  return chapter && anecdote ? { chapter, anecdote } : undefined;
}

/** Approving is the moment AI-drafted text becomes something the family owns. */
export function approveAnecdoteInDoc(
  doc: LifeStoryDocument,
  ref: AnecdoteRef,
): LifeStoryDocument | undefined {
  return mapAnecdote(doc, ref, (anecdote) => ({ ...anecdote, approved: true }));
}

/** An edit is also an approval: they have made it theirs by rewriting it. */
export function editAnecdoteInDoc(
  doc: LifeStoryDocument,
  ref: AnecdoteRef,
  text: string,
): LifeStoryDocument | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return mapAnecdote(doc, ref, (anecdote) => ({
    ...anecdote,
    text: trimmed,
    source: 'organizer',
    approved: true,
  }));
}

/**
 * Removing is the one destructive verb, and only a person can reach it — the
 * interview has no way to call this.
 */
export function removeAnecdoteFromDoc(
  doc: LifeStoryDocument,
  ref: AnecdoteRef,
): LifeStoryDocument | undefined {
  if (!findAnecdote(doc, ref)) return undefined;
  return {
    ...doc,
    chapters: doc.chapters.map((chapter) =>
      chapter.id === ref.chapterId
        ? { ...chapter, anecdotes: chapter.anecdotes.filter((a) => a.id !== ref.anecdoteId) }
        : chapter,
    ),
  };
}

function mapAnecdote(
  doc: LifeStoryDocument,
  ref: AnecdoteRef,
  map: (anecdote: Anecdote) => Anecdote,
): LifeStoryDocument | undefined {
  if (!findAnecdote(doc, ref)) return undefined;
  return {
    ...doc,
    chapters: doc.chapters.map((chapter) =>
      chapter.id === ref.chapterId
        ? {
            ...chapter,
            anecdotes: chapter.anecdotes.map((a) => (a.id === ref.anecdoteId ? map(a) : a)),
          }
        : chapter,
    ),
  };
}

export type DocProgress = {
  chapters: number;
  anecdotes: number;
  approvedAnecdotes: number;
  pendingAnecdotes: number;
  themes: number;
};

/** Counts for the dashboard card and the "story so far" panel. */
export function docProgress(doc: LifeStoryDocument): DocProgress {
  const anecdotes = doc.chapters.flatMap((chapter) => chapter.anecdotes);
  const approved = anecdotes.filter((anecdote) => anecdote.approved).length;
  return {
    chapters: doc.chapters.length,
    anecdotes: anecdotes.length,
    approvedAnecdotes: approved,
    pendingAnecdotes: anecdotes.length - approved,
    themes: doc.themes.length,
  };
}

/**
 * One line about how far the story has come.
 *
 * It never scolds and never counts down to a target, because there is no right
 * amount of story. It says what is there, and — when there is something waiting
 * — what would help.
 */
export function storyProgressLine(progress: DocProgress, name: string): string {
  if (progress.chapters === 0) {
    return `Nothing written down yet. The first question takes about a minute.`;
  }
  const chapters = `${progress.chapters} ${progress.chapters === 1 ? 'chapter' : 'chapters'} so far`;
  if (progress.pendingAnecdotes > 0) {
    return (
      `${name}'s story is taking shape — ${chapters}, and ` +
      `${progress.pendingAnecdotes} ${progress.pendingAnecdotes === 1 ? 'memory' : 'memories'} waiting for you to say yes.`
    );
  }
  return `${name}'s story is taking shape — ${chapters}.`;
}
