import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  eq,
  getById,
  insertOne,
  listWhere,
  memorials,
  participants,
  renderJobs,
  reviewNotes,
  slideshowProjects,
  sql,
  updateById,
  type Db,
} from '@col/db';
import { EdlSchema, type Edl } from '@col/schemas';
import { projectCut } from '../edl/timing';
import {
  MAX_NOTE_CHARS,
  MAX_WATCH_NOTES_PER_MEMORIAL,
  addReviewNote,
  cleanNoteText,
  countOpenReviewNotes,
  describeAge,
  formatTimecode,
  listReviewNotes,
  noteInvitation,
  notePrivacyLine,
  organizerDisplayName,
  reviewNoteViews,
  setReviewNoteStatus,
  slideIdAt,
} from './notes';
import {
  acceptCoOrganizerInvite,
  createCoOrganizerInvite,
  listCoOrganizerInvites,
  resolveInviteToken,
  revokeCoOrganizerInvite,
} from './invites';

const crossfade = { kind: 'crossfade' as const, durationSec: 0.8 };
const kenBurns = {
  from: { x: 0, y: 0, w: 1, h: 1 },
  to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  easing: 'easeInOut' as const,
};

/** Title, three photographs, a closing card — the shape of every real one. */
function edl(projectId: string): Edl {
  return EdlSchema.parse({
    version: 1,
    projectId,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    audio: { mode: 'sideloaded', startOffsetSec: 0 },
    theme: { id: 'quiet-linen' },
    chapters: [
      { id: 'opening', title: 'Opening', slideIds: ['title'] },
      { id: 'c1', title: 'Where she began', slideIds: ['c1-s1', 'c1-s2'] },
      { id: 'closing', title: 'Closing', slideIds: ['closing'] },
    ],
    slides: {
      title: {
        kind: 'title',
        text: 'Ruth Anne Kelleher',
        durationSec: 4,
        transitionOut: crossfade,
      },
      'c1-s1': {
        kind: 'photo',
        assetId: 'asset-1',
        variant: 'render2400',
        durationSec: 5,
        kenBurns,
        caption: { text: 'The lake', position: 'lower-third' },
        transitionOut: crossfade,
      },
      'c1-s2': {
        kind: 'photo',
        assetId: 'asset-2',
        variant: 'render2400',
        durationSec: 5,
        kenBurns,
        transitionOut: crossfade,
      },
      closing: { kind: 'closing', line1: 'Ruth', line2: '1938 — 2024', durationSec: 6 },
    },
    cuts: { service: { targetSec: 300 }, family: { targetSec: 420 } },
  });
}

let db: Db;
let memorialId: string;
let otherMemorialId: string;
let renderJobId: string;

beforeEach(() => {
  process.env['APP_BASE_URL'] = 'https://example.test';
  db = createTestDb();
  memorialId = insertOne(db, memorials, { decedentName: 'Ruth Anne Kelleher' }).id;
  otherMemorialId = insertOne(db, memorials, { decedentName: 'Patrick Byrne' }).id;
  insertOne(db, participants, {
    memorialId,
    role: 'organizer',
    displayName: 'Anne Doyle',
    email: 'anne@example.test',
  });

  const project = insertOne(db, slideshowProjects, { memorialId } as never) as { id: string };
  updateById(db, slideshowProjects, project.id, { edl: edl(project.id), edlVersion: 1 });
  renderJobId = (
    insertOne(db, renderJobs, {
      memorialId,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
      status: 'done',
      progress: 1,
      outputBlobKey: `memorial/${memorialId}/render/final.mp4`,
    } as never) as { id: string }
  ).id;
});

/* -------------------------------------------------------------------------- */
/* what somebody typed                                                         */
/* -------------------------------------------------------------------------- */

describe('the words a viewer sends', () => {
  it('keeps the sentence and drops the markup', () => {
    const cleaned = cleanNoteText('That is <b>Margaret</b>, not Ruth<script>alert(1)</script>');
    expect(cleaned).toContain('That is Margaret, not Ruth');
    expect(cleaned).not.toContain('<');
    expect(cleaned).not.toContain('alert');
  });

  it('keeps paragraph breaks, because people write in two thoughts', () => {
    expect(cleanNoteText('One thing.\n\nAnother thing.')).toBe('One thing.\n\nAnother thing.');
  });

  it('caps the length rather than refusing the note', () => {
    const long = 'a'.repeat(MAX_NOTE_CHARS + 500);
    const result = addReviewNote(db, { memorialId, body: long });
    expect(result.ok).toBe(true);
    expect(result.ok && result.note.body.length).toBe(MAX_NOTE_CHARS);
  });

  it('will not store an empty one', () => {
    const result = addReviewNote(db, { memorialId, body: '   <b> </b>  ' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('empty');
    expect(listReviewNotes(db, memorialId)).toHaveLength(0);
  });

  it('stops gently once a link has left far more notes than any family leaves', () => {
    for (let i = 0; i < MAX_WATCH_NOTES_PER_MEMORIAL; i += 1) {
      expect(addReviewNote(db, { memorialId, body: `note ${i}` }).ok).toBe(true);
    }
    const extra = addReviewNote(db, { memorialId, body: 'one too many' });
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.reason).toBe('too-many');
    // The ones they did leave are all still there.
    expect(listReviewNotes(db, memorialId)).toHaveLength(MAX_WATCH_NOTES_PER_MEMORIAL);
  });

  it('refuses to write against a memorial that has been removed', () => {
    updateById(db, memorials, memorialId, { deletedAt: Date.now() });
    const result = addReviewNote(db, { memorialId, body: 'anything' });
    expect(result.ok === false && result.reason).toBe('gone');
  });
});

/* -------------------------------------------------------------------------- */
/* where in the video                                                          */
/* -------------------------------------------------------------------------- */

describe('the moment they pressed the button', () => {
  it('is written as a person would say it', () => {
    expect(formatTimecode(83_000)).toBe('1:23');
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(605_000)).toBe('10:05');
  });

  it('resolves to the slide that was on screen, and keeps the raw time', () => {
    const project = listWhere(
      db,
      slideshowProjects,
      eq(slideshowProjects.memorialId, memorialId),
    )[0];
    const timeline = projectCut(edl(project?.id as string), 'service');
    const secondPhoto = timeline.slides[2];
    const middle = ((secondPhoto?.startSec ?? 0) + 0.5) * 1000;

    const result = addReviewNote(db, {
      memorialId,
      renderJobId,
      body: 'Is that the right year?',
      timecodeMs: middle,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.note.slideId).toBe(secondPhoto?.slideId);
    expect(result.ok && result.note.timecodeMs).toBe(Math.round(middle));
  });

  it('still keeps the note when there is no timeline to read', () => {
    const bare = insertOne(db, memorials, { decedentName: 'Margaret Doyle' }).id;
    const result = addReviewNote(db, { memorialId: bare, body: 'lovely', timecodeMs: 4000 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.note.slideId).toBeNull();
    expect(result.ok && result.note.timecodeMs).toBe(4000);
  });

  it('points at nothing rather than guessing past the end of the video', () => {
    const project = listWhere(
      db,
      slideshowProjects,
      eq(slideshowProjects.memorialId, memorialId),
    )[0];
    const timeline = projectCut(edl(project?.id as string), 'service');
    expect(slideIdAt(timeline, 0)).toBe(timeline.slides[0]?.slideId);
    expect(slideIdAt(timeline, (timeline.totalSec + 30) * 1000)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* what the organiser reads                                                    */
/* -------------------------------------------------------------------------- */

describe('the organiser’s list', () => {
  it('is newest first, and says where and when in plain words', () => {
    const now = Date.UTC(2026, 2, 14, 12, 0, 0);
    addReviewNote(db, {
      memorialId,
      renderJobId,
      body: 'That is Margaret, not Ruth.',
      authorName: 'Michael',
      timecodeMs: 6000,
    });
    addReviewNote(db, { memorialId, body: 'It is lovely.', authorName: 'Bridget' });

    const views = reviewNoteViews(db, memorialId, { now });
    expect(views[0]?.note.body).toBe('It is lovely.');
    expect(views[1]?.authorLabel).toBe('Michael');
    expect(views[1]?.whereLine).toContain('at 0:06');
    // Resolved to a real slide, so the row can link straight at it.
    expect(views[1]?.href).toContain(`/m/${memorialId}/preview#slide-`);
    expect(views[0]?.ageLabel).toBe('just now');
  });

  it('names the photograph when the slide carries a caption', () => {
    const project = listWhere(
      db,
      slideshowProjects,
      eq(slideshowProjects.memorialId, memorialId),
    )[0];
    const timeline = projectCut(edl(project?.id as string), 'service');
    const lake = timeline.slides.find((slide) => slide.slideId === 'c1-s1');
    addReviewNote(db, {
      memorialId,
      renderJobId,
      body: 'Wrong lake, I think.',
      timecodeMs: ((lake?.startSec ?? 0) + 0.5) * 1000,
    });
    expect(reviewNoteViews(db, memorialId)[0]?.whereLine).toContain('the photo of the lake');
  });

  it('has a kind stand-in for somebody who left no name', () => {
    addReviewNote(db, { memorialId, body: 'The spelling on the last card.' });
    expect(reviewNoteViews(db, memorialId)[0]?.authorLabel).toMatch(/Someone/);
  });

  it('describes age the way a person would', () => {
    const now = Date.UTC(2026, 2, 14, 12, 0, 0);
    expect(describeAge(now - 30_000, now)).toBe('just now');
    expect(describeAge(now - 26 * 60 * 60 * 1000, now)).toBe('yesterday');
    expect(describeAge(now - 4 * 24 * 60 * 60 * 1000, now)).toBe('4 days ago');
    expect(describeAge(now - 21 * 24 * 60 * 60 * 1000, now)).toBe('3 weeks ago');
  });

  it('addresses the invitation to the organiser by name, and promises privacy', () => {
    expect(organizerDisplayName(db, memorialId)).toBe('Anne Doyle');
    expect(noteInvitation('Anne Doyle')).toBe('Spotted something, or have a thought? Tell Anne.');
    expect(notePrivacyLine('Anne Doyle')).toBe('Only Anne will see this.');
    expect(noteInvitation(undefined)).toContain('the family');
  });
});

describe('done, and not now', () => {
  it('flips the status and reports what it was, so Undo can put it back', () => {
    addReviewNote(db, { memorialId, body: 'The date on the closing card.' });
    const note = listReviewNotes(db, memorialId)[0];
    expect(countOpenReviewNotes(db, memorialId)).toBe(1);

    const done = setReviewNoteStatus(db, memorialId, note?.id as string, 'done');
    expect(done?.previous).toBe('open');
    expect(done?.note.status).toBe('done');
    expect(done?.message).not.toMatch(/permanently|cannot|warning/i);
    expect(countOpenReviewNotes(db, memorialId)).toBe(0);

    const back = setReviewNoteStatus(db, memorialId, note?.id as string, done?.previous ?? 'open');
    expect(back?.note.status).toBe('open');
    expect(countOpenReviewNotes(db, memorialId)).toBe(1);
    // Nothing was thrown away on the way round.
    expect(getById(db, reviewNotes, note?.id as string)?.body).toBe(
      'The date on the closing card.',
    );
  });

  it('is not something another family can do', () => {
    addReviewNote(db, { memorialId, body: 'anything' });
    const note = listReviewNotes(db, memorialId)[0];
    expect(setReviewNoteStatus(db, otherMemorialId, note?.id as string, 'done')).toBeUndefined();
    expect(getById(db, reviewNotes, note?.id as string)?.status).toBe('open');
  });
});

/* -------------------------------------------------------------------------- */
/* sharing the work                                                            */
/* -------------------------------------------------------------------------- */

describe('inviting a co-organiser', () => {
  it('makes a link that can be shown again, scoped to this memorial', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    expect(invite.active).toBe(true);
    expect(invite.row.kind).toBe('co-organizer-invite');
    expect(invite.row.scopes).toEqual(['co-organizer-invite']);
    expect(invite.url).toBe(`https://example.test/join/${invite.token}`);
    expect(listCoOrganizerInvites(db, memorialId)[0]?.url).toBe(invite.url);
  });

  it('never writes the plaintext into the database', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    const rows = JSON.stringify(listCoOrganizerInvites(db, memorialId).map((i) => i.row));
    expect(rows).not.toContain(invite.token as string);
  });

  it('makes an organizer of whoever opens it, on that memorial only', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    const result = acceptCoOrganizerInvite(db, {
      token: invite.token as string,
      firstName: 'Michael',
      email: 'Michael@Example.test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.memorial.id).toBe(memorialId);
    expect(result.participant.role).toBe('organizer');
    expect(result.participant.displayName).toBe('Michael');
    // Normalised, because this is how they will be found again by email.
    expect(result.participant.email).toBe('michael@example.test');
    // And nothing at all was created against the other family.
    expect(listWhere(db, participants, eq(participants.memorialId, otherMemorialId))).toHaveLength(
      0,
    );
  });

  it('keeps working, and the same person coming back is the same person', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    const token = invite.token as string;
    const first = acceptCoOrganizerInvite(db, { token, firstName: 'Michael', email: 'm@x.test' });
    const second = acceptCoOrganizerInvite(db, { token, firstName: 'Michael', email: 'm@x.test' });
    expect(first.ok && second.ok && first.participant.id).toBe(
      second.ok ? second.participant.id : '',
    );
    expect(
      listWhere(db, participants, eq(participants.memorialId, memorialId)).filter(
        (p) => p.email === 'm@x.test',
      ),
    ).toHaveLength(1);
  });

  it('promotes a contributor in place rather than making a second row for them', () => {
    const contributor = insertOne(db, participants, {
      memorialId,
      role: 'contributor',
      displayName: 'Michael',
      email: 'michael@example.test',
    });
    const invite = createCoOrganizerInvite(db, memorialId);
    const result = acceptCoOrganizerInvite(db, {
      token: invite.token as string,
      firstName: 'Michael',
      email: 'michael@example.test',
    });
    expect(result.ok && result.participant.id).toBe(contributor.id);
    expect(result.ok && result.participant.role).toBe('organizer');
  });

  it('stops opening once it is turned off', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    const token = invite.token as string;
    expect(revokeCoOrganizerInvite(db, memorialId, invite.row.id)).toBe(true);

    const resolved = resolveInviteToken(db, token);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toBe('revoked');
    expect(acceptCoOrganizerInvite(db, { token, firstName: 'Late', email: 'l@x.test' }).ok).toBe(
      false,
    );
  });

  it('refuses to be turned off by another family', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    expect(revokeCoOrganizerInvite(db, otherMemorialId, invite.row.id)).toBe(false);
    expect(resolveInviteToken(db, invite.token as string).ok).toBe(true);
  });

  it('will not open a memorial that has been removed', () => {
    const invite = createCoOrganizerInvite(db, memorialId);
    updateById(db, memorials, memorialId, { deletedAt: Date.now() });
    const resolved = resolveInviteToken(db, invite.token as string);
    expect(resolved.ok === false && resolved.reason).toBe('gone');
  });
});

/* -------------------------------------------------------------------------- */
/* deletion                                                                    */
/* -------------------------------------------------------------------------- */

describe('when a memorial is really deleted', () => {
  it('takes every note from the family with it', () => {
    addReviewNote(db, { memorialId, renderJobId, body: 'That is Margaret.', timecodeMs: 6000 });
    addReviewNote(db, { memorialId, body: 'It is lovely.' });
    expect(listReviewNotes(db, memorialId)).toHaveLength(2);

    // The purge is a real delete of the memorial row; the cascade is the
    // promise. Foreign keys are on because that is how the application runs.
    db.$sqlite.exec('PRAGMA foreign_keys = ON');
    db.delete(memorials).where(eq(memorials.id, memorialId)).run();

    expect(listWhere(db, reviewNotes, sql`1 = 1`)).toHaveLength(0);
  });
});
