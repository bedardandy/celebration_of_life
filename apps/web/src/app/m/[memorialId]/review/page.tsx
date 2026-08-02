/**
 * What the family said.
 *
 * The organiser has sent the video to eleven people and three of them have
 * written back. This is that, as a list rather than as eleven text messages:
 * newest first, each one saying who wrote it, when, and where in the video they
 * were — "at 1:23 — the photo of the lake" — with a link straight to that slide
 * so the fix is one tap away from the remark.
 *
 * The two buttons are quiet on purpose. Nothing here is urgent, nothing is a
 * task list, and nothing scolds an organiser who reads them all and changes
 * none of them.
 */
import Link from 'next/link';
import { REVIEW_EMPTY_STATE, reviewNoteViews, type ReviewNoteView } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { NoteActions } from './NoteActions';
import styles from './review.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Notes from family' };

export default async function ReviewPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const views = reviewNoteViews(db(), memorialId);
  const open = views.filter((view) => view.note.status === 'open');
  const settled = views.filter((view) => view.note.status !== 'open');

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Notes from family"
      helper={
        open.length === 0
          ? 'Anything family write after watching the video arrives here.'
          : `${open.length} ${open.length === 1 ? 'note' : 'notes'} to look at. Nothing here is urgent.`
      }
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/preview`}>
          Open the slideshow to change something
        </Link>
      }
      secondary={
        <>
          <Link href={`/m/${memorialId}/deliver#watch`}>The viewing link</Link>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </>
      }
      footer="Only you see these. Nobody watching the video can see what anyone else wrote."
    >
      {open.length === 0 && settled.length === 0 ? (
        <p className={styles.empty}>{REVIEW_EMPTY_STATE}</p>
      ) : null}

      {open.length > 0 ? (
        <ul className={styles.list}>
          {open.map((view) => (
            <NoteCard key={view.note.id} memorialId={memorialId} view={view} />
          ))}
        </ul>
      ) : null}

      {settled.length > 0 ? (
        <section className={styles.settled}>
          <h2 className={styles.settledTitle}>Already looked at</h2>
          <p className={styles.settledHelp}>
            Still here, and still theirs. Put any of them back whenever you like.
          </p>
          <ul className={styles.list}>
            {settled.map((view) => (
              <NoteCard key={view.note.id} memorialId={memorialId} view={view} />
            ))}
          </ul>
        </section>
      ) : null}
    </StepScreen>
  );
}

function NoteCard({ memorialId, view }: { memorialId: string; view: ReviewNoteView }) {
  const { note } = view;
  return (
    <li className={`${styles.note} ${note.status === 'open' ? '' : styles.noteSettled}`}>
      <p className={styles.who}>
        <strong>{view.authorLabel}</strong>
        <span className={styles.age}>{view.ageLabel}</span>
      </p>

      <p className={styles.body}>{note.body}</p>

      {view.whereLine ? (
        <p className={styles.where}>
          {view.href ? (
            <Link href={view.href}>{view.whereLine}</Link>
          ) : (
            <span>{view.whereLine}</span>
          )}
        </p>
      ) : null}

      <div className={styles.buttons}>
        <NoteActions memorialId={memorialId} noteId={note.id} status={note.status} />
      </div>
    </li>
  );
}
