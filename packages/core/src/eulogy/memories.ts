/**
 * The memories a speaker can build a eulogy out of.
 *
 * Two sources, both of them somebody's actual words that somebody has already
 * approved: memory notes sent in by family and friends, and anecdotes in the
 * life story document the organizer has ticked. Nothing AI-drafted and
 * unapproved is offered, and nothing the speaker did not tick is sent to a
 * model — the whole studio hangs off that.
 *
 * Ids are prefixed by source so a note and an anecdote can never collide, and
 * so a stored `selectedMemoryIds` list still means something after a chapter
 * has been renamed.
 */
import { eq, listAlive, memoryNotes, type Db, type Memorial, type MemoryNote } from '@col/db';
import type { LifeStoryDocument } from '@col/schemas';
import { currentDoc } from '../interview/store';
import { subjectOf } from '../interview/engine';

export type MemorySource = 'memory-note' | 'story';

export type SelectableMemory = {
  /** `note:<rowId>` or `story:<chapterId>:<anecdoteId>`. */
  id: string;
  text: string;
  /** Whose words these are, as the speech would credit them. */
  attribution: string;
  source: MemorySource;
  /** Which chapter it came from, for the checkbox list's grouping. */
  chapterTitle?: string;
};

export function memoryNoteId(noteId: string): string {
  return `note:${noteId}`;
}

export function storyMemoryId(chapterId: string, anecdoteId: string): string {
  return `story:${chapterId}:${anecdoteId}`;
}

/** Memory notes contributors sent in, once the organizer has approved them. */
export function approvedNotes(db: Db, memorialId: string): MemoryNote[] {
  return listAlive(db, memoryNotes, eq(memoryNotes.memorialId, memorialId), 500)
    .filter((note) => note.approved && note.text.trim().length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function memoriesFromDoc(doc: LifeStoryDocument, subjectName: string): SelectableMemory[] {
  const out: SelectableMemory[] = [];
  for (const chapter of doc.chapters) {
    for (const anecdote of chapter.anecdotes) {
      if (!anecdote.approved) continue;
      const text = anecdote.text.trim();
      if (!text) continue;
      out.push({
        id: storyMemoryId(chapter.id, anecdote.id),
        text,
        attribution: `From ${subjectName}'s story`,
        source: 'story',
        chapterTitle: chapter.title,
      });
    }
  }
  return out;
}

/**
 * Everything a speech may be built from, in the order the setup screen shows
 * it: other people's words first, because those are the ones a speaker is most
 * likely to have forgotten they had.
 */
export function selectableMemories(db: Db, memorial: Memorial): SelectableMemory[] {
  const out: SelectableMemory[] = [];

  for (const note of approvedNotes(db, memorial.id)) {
    out.push({
      id: memoryNoteId(note.id),
      text: note.text.trim(),
      attribution: note.authorName?.trim() || 'Someone who loved them',
      source: 'memory-note',
    });
  }

  const { doc } = currentDoc(db, memorial.id, subjectOf(memorial));
  out.push(...memoriesFromDoc(doc, memorial.decedentName));

  // Two people can write down the same sentence; a speaker should only be
  // offered it once, and the first one keeps its attribution.
  const seen = new Set<string>();
  return out.filter((memory) => {
    const key = memory.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The ticked ones, in the order they were offered. */
export function pickMemories(
  all: readonly SelectableMemory[],
  selectedIds: readonly string[],
): SelectableMemory[] {
  const wanted = new Set(selectedIds);
  return all.filter((memory) => wanted.has(memory.id));
}
