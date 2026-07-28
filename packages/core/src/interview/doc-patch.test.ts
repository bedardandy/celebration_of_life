import { describe, expect, it } from 'vitest';
import type { DocPatch, LifeStoryDocument } from '@col/schemas';
import { LifeStoryDocumentSchema } from '@col/schemas';
import {
  applyDocPatch,
  approveAnecdoteInDoc,
  docProgress,
  editAnecdoteInDoc,
  emptyLifeStoryDocument,
  removeAnecdoteFromDoc,
  titleFromId,
} from './doc-patch';

/** Ids are injected so every assertion below is about merging, not randomness. */
function ids(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function patch(overrides: Partial<DocPatch> = {}): DocPatch {
  return {
    chapterUpserts: [],
    themeAdds: [],
    openQuestionAdds: [],
    anecdoteAdds: [],
    ...overrides,
  };
}

const ruth = () => emptyLifeStoryDocument({ fullName: 'Ruth Hartley', knownAs: 'Ruth' });

function withChapter(
  doc: LifeStoryDocument,
  chapter: Partial<LifeStoryDocument['chapters'][number]>,
) {
  return {
    ...doc,
    chapters: [
      {
        id: 'early-years',
        title: 'A farmhouse outside Bellwood',
        era: { from: 1936 },
        summary: 'Born on a farm.',
        anecdotes: [],
        people: [],
        openQuestions: [],
        ...chapter,
      },
    ],
  };
}

describe('applyDocPatch — creating', () => {
  it('adds a chapter and keeps the document schema-valid', () => {
    const result = applyDocPatch(
      ruth(),
      patch({
        chapterUpserts: [
          { id: 'early-years', title: 'A farmhouse outside Bellwood', summary: 'Born on a farm.' },
        ],
      }),
      { newId: ids() },
    );
    expect(result.changed).toBe(true);
    expect(result.createdChapterIds).toEqual(['early-years']);
    expect(LifeStoryDocumentSchema.safeParse(result.doc).success).toBe(true);
  });

  it('falls back to a readable title when the patch does not give one', () => {
    const result = applyDocPatch(ruth(), patch({ chapterUpserts: [{ id: 'the-garden' }] }), {
      newId: ids(),
    });
    expect(result.doc.chapters[0]?.title).toBe('The garden');
    expect(titleFromId('walter-and-the-children')).toBe('Walter and the children');
  });

  it('reports no change for an empty patch, so no doc version is written', () => {
    const result = applyDocPatch(ruth(), patch(), { newId: ids() });
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(ruth().chapters === result.doc.chapters ? result.doc : result.doc);
  });

  it('never mutates the document it was given', () => {
    const doc = ruth();
    applyDocPatch(doc, patch({ chapterUpserts: [{ id: 'x', title: 'X' }] }), { newId: ids() });
    expect(doc.chapters).toHaveLength(0);
  });
});

describe('applyDocPatch — merging chapters', () => {
  it('upserts by id rather than adding a duplicate', () => {
    const doc = withChapter(ruth(), {});
    const result = applyDocPatch(
      doc,
      patch({ chapterUpserts: [{ id: 'early-years', era: { to: 1954 } }] }),
      { newId: ids() },
    );
    expect(result.doc.chapters).toHaveLength(1);
    expect(result.doc.chapters[0]?.era).toEqual({ from: 1936, to: 1954 });
  });

  it('leaves fields the patch does not mention completely alone', () => {
    const doc = withChapter(ruth(), { summary: 'Born on a farm.', people: ['Her mother'] });
    const result = applyDocPatch(
      doc,
      patch({ chapterUpserts: [{ id: 'early-years', title: 'The farm' }] }),
      { newId: ids() },
    );
    expect(result.doc.chapters[0]?.summary).toBe('Born on a farm.');
    expect(result.doc.chapters[0]?.people).toEqual(['Her mother']);
  });

  it('keeps the fuller summary when a later turn comes back shorter', () => {
    const doc = withChapter(ruth(), {
      summary: 'Born in 1936 on a farm outside Bellwood, where her mother kept bees.',
    });
    const result = applyDocPatch(
      doc,
      patch({ chapterUpserts: [{ id: 'early-years', summary: 'Born on a farm.' }] }),
      { newId: ids() },
    );
    expect(result.doc.chapters[0]?.summary).toContain('kept bees');
    expect(result.changed).toBe(false);
  });

  it('unions people and open questions without duplicating them', () => {
    const doc = withChapter(ruth(), {
      people: ['Walter'],
      openQuestions: ['Where did they meet?'],
    });
    const result = applyDocPatch(
      doc,
      patch({
        chapterUpserts: [
          {
            id: 'early-years',
            people: ['walter', 'Susan'],
            openQuestions: ['  Where did they   meet? ', 'Any photographs?'],
          },
        ],
      }),
      { newId: ids() },
    );
    expect(result.doc.chapters[0]?.people).toEqual(['Walter', 'Susan']);
    expect(result.doc.chapters[0]?.openQuestions).toEqual([
      'Where did they meet?',
      'Any photographs?',
    ]);
  });

  it('dedupes themes case-insensitively', () => {
    const doc = { ...ruth(), themes: ['Growing things'] };
    const result = applyDocPatch(doc, patch({ themeAdds: ['growing things', 'Teaching'] }), {
      newId: ids(),
    });
    expect(result.doc.themes).toEqual(['Growing things', 'Teaching']);
  });
});

describe('applyDocPatch — anecdotes', () => {
  it('adds anecdotes unapproved, always', () => {
    const doc = withChapter(ruth(), {});
    const result = applyDocPatch(
      doc,
      patch({
        anecdoteAdds: [
          { chapterId: 'early-years', text: 'Her mother kept bees.', source: 'interview' },
        ],
      }),
      { newId: ids('anec') },
    );
    const anecdote = result.doc.chapters[0]?.anecdotes[0];
    expect(anecdote).toMatchObject({ id: 'anec-1', approved: false, source: 'interview' });
    expect(result.addedAnecdoteIds).toEqual(['anec-1']);
  });

  it('never drops an anecdote, even with no chapter to put it in', () => {
    const result = applyDocPatch(
      ruth(),
      patch({
        anecdoteAdds: [{ text: 'She always said "Well, we\'ll see."', source: 'interview' }],
      }),
      { newId: ids('new') },
    );
    expect(result.doc.chapters).toHaveLength(1);
    expect(result.doc.chapters[0]?.title).toBe('Their life');
    expect(result.doc.chapters[0]?.anecdotes[0]?.text).toContain("we'll see");
  });

  it('lands loose anecdotes in the chapter this same patch created', () => {
    const result = applyDocPatch(
      ruth(),
      patch({
        chapterUpserts: [{ id: 'the-garden', title: 'The dahlias' }],
        anecdoteAdds: [
          { text: 'She won the county show three years running.', source: 'interview' },
        ],
      }),
      { newId: ids() },
    );
    expect(result.doc.chapters).toHaveLength(1);
    expect(result.doc.chapters[0]?.id).toBe('the-garden');
    expect(result.doc.chapters[0]?.anecdotes).toHaveLength(1);
  });

  it('does not add the same anecdote twice', () => {
    const doc = withChapter(ruth(), {
      anecdotes: [{ id: 'a1', text: 'Her mother kept bees.', source: 'interview', approved: true }],
    });
    const result = applyDocPatch(
      doc,
      patch({
        anecdoteAdds: [
          { chapterId: 'early-years', text: '  her mother kept BEES.  ', source: 'interview' },
        ],
      }),
      { newId: ids() },
    );
    expect(result.doc.chapters[0]?.anecdotes).toHaveLength(1);
    expect(result.changed).toBe(false);
  });

  it('cannot remove or reword anything a person has approved', () => {
    const doc = withChapter(ruth(), {
      summary: 'The long, careful, organizer-written summary of these years.',
      anecdotes: [{ id: 'a1', text: 'The approved one.', source: 'organizer', approved: true }],
    });
    const result = applyDocPatch(
      doc,
      patch({
        chapterUpserts: [{ id: 'early-years', summary: 'short', people: [] }],
        anecdoteAdds: [{ chapterId: 'early-years', text: 'Another one.', source: 'interview' }],
      }),
      { newId: ids() },
    );
    const chapter = result.doc.chapters[0];
    expect(chapter?.anecdotes[0]).toEqual({
      id: 'a1',
      text: 'The approved one.',
      source: 'organizer',
      approved: true,
    });
    expect(chapter?.summary).toContain('organizer-written');
    expect(chapter?.anecdotes).toHaveLength(2);
  });
});

describe('applyDocPatch — open questions', () => {
  it('files loose open questions on the chapter under discussion', () => {
    const doc = withChapter(ruth(), {});
    const result = applyDocPatch(
      doc,
      patch({
        chapterUpserts: [{ id: 'early-years' }],
        openQuestionAdds: ['What did the farm grow?'],
      }),
      { newId: ids() },
    );
    expect(result.doc.chapters[0]?.openQuestions).toEqual(['What did the farm grow?']);
  });

  it('drops them when there is no chapter at all — they are our notes, not theirs', () => {
    const result = applyDocPatch(ruth(), patch({ openQuestionAdds: ['Anything?'] }), {
      newId: ids(),
    });
    expect(result.changed).toBe(false);
    expect(result.doc.chapters).toHaveLength(0);
  });
});

describe('organizer edits', () => {
  const doc = () =>
    withChapter(ruth(), {
      anecdotes: [{ id: 'a1', text: 'A draft.', source: 'interview', approved: false }],
    });
  const ref = { chapterId: 'early-years', anecdoteId: 'a1' };

  it('approving is what turns a draft into something the family owns', () => {
    expect(approveAnecdoteInDoc(doc(), ref)?.chapters[0]?.anecdotes[0]?.approved).toBe(true);
  });

  it('editing is also approving, and changes the provenance', () => {
    const next = editAnecdoteInDoc(doc(), ref, '  Her own words.  ');
    expect(next?.chapters[0]?.anecdotes[0]).toMatchObject({
      text: 'Her own words.',
      source: 'organizer',
      approved: true,
    });
  });

  it('refuses to blank an anecdote by editing it to nothing', () => {
    expect(editAnecdoteInDoc(doc(), ref, '   ')).toBeUndefined();
  });

  it('removes only what was asked for', () => {
    const next = removeAnecdoteFromDoc(doc(), ref);
    expect(next?.chapters[0]?.anecdotes).toHaveLength(0);
    expect(next?.chapters).toHaveLength(1);
  });

  it('says nothing happened for an anecdote that is not there', () => {
    const missing = { chapterId: 'early-years', anecdoteId: 'nope' };
    expect(approveAnecdoteInDoc(doc(), missing)).toBeUndefined();
    expect(removeAnecdoteFromDoc(doc(), missing)).toBeUndefined();
  });
});

describe('docProgress', () => {
  it('counts what the dashboard card needs to say', () => {
    const doc = withChapter(
      { ...ruth(), themes: ['Growing things'] },
      {
        anecdotes: [
          { id: 'a1', text: 'One.', source: 'interview', approved: true },
          { id: 'a2', text: 'Two.', source: 'interview', approved: false },
        ],
      },
    );
    expect(docProgress(doc)).toEqual({
      chapters: 1,
      anecdotes: 2,
      approvedAnecdotes: 1,
      pendingAnecdotes: 1,
      themes: 1,
    });
  });
});
