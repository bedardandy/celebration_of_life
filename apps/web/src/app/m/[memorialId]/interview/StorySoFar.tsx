/**
 * Her story so far.
 *
 * A server component: it is a view of the current document version, and every
 * control on it is a plain form posting to a server action, so it works with
 * JavaScript off and it never holds state that could disagree with the database.
 *
 * The controls are the point. Everything the interview drafts arrives
 * unapproved, and this is where a person says "yes, that is true", "not quite,
 * here is what actually happened", or "no". Nothing rendered from this document
 * later will use an anecdote that has not been through one of those.
 */
import type { LifeStoryDocument } from '@col/schemas';
import { step } from '@/components/StepScreen';
import { anecdoteAction } from './actions';
import styles from './interview.module.css';

export type StorySoFarProps = {
  memorialId: string;
  doc: LifeStoryDocument;
  subjectName: string;
  returnTo: string;
  /** Open by default on the story page, folded away beside a question. */
  defaultOpen?: boolean;
};

export function StorySoFar({
  memorialId,
  doc,
  subjectName,
  returnTo,
  defaultOpen = false,
}: StorySoFarProps) {
  const hasContent = doc.chapters.length > 0;

  return (
    <details className={styles.aside} open={defaultOpen || hasContent}>
      <summary className={styles.asideSummary}>{subjectName}&rsquo;s story so far</summary>

      {!hasContent ? (
        <p className={styles.asideEmpty}>
          Nothing here yet. It fills in as you answer — you will see the chapters appear.
        </p>
      ) : null}

      {doc.chapters.map((chapter) => (
        <section key={chapter.id} className={styles.chapter}>
          <h3 className={styles.chapterTitle}>
            {chapter.title}
            {chapter.era.from ? (
              <span className={styles.chapterEra}>
                {' '}
                {chapter.era.from}
                {chapter.era.to ? `–${chapter.era.to}` : ''}
              </span>
            ) : null}
          </h3>
          {chapter.summary ? <p className={styles.chapterSummary}>{chapter.summary}</p> : null}

          {chapter.anecdotes.length > 0 ? (
            <ul className={styles.anecdotes}>
              {chapter.anecdotes.map((anecdote) => (
                <li
                  key={anecdote.id}
                  className={`${styles.anecdote} ${anecdote.approved ? styles.anecdoteApproved : ''}`}
                >
                  <AnecdoteRow
                    memorialId={memorialId}
                    chapterId={chapter.id}
                    returnTo={returnTo}
                    anecdote={anecdote}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      {doc.themes.length > 0 ? (
        <p className={styles.themes}>Threads running through it: {doc.themes.join(', ')}.</p>
      ) : null}
    </details>
  );
}

function AnecdoteRow({
  memorialId,
  chapterId,
  returnTo,
  anecdote,
}: {
  memorialId: string;
  chapterId: string;
  returnTo: string;
  anecdote: LifeStoryDocument['chapters'][number]['anecdotes'][number];
}) {
  const hidden = (
    <>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="chapterId" value={chapterId} />
      <input type="hidden" name="anecdoteId" value={anecdote.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );

  return (
    <>
      <p className={styles.anecdoteText}>{anecdote.text}</p>
      <p className={styles.anecdoteMeta}>
        {anecdote.approved ? '✓ Kept in the story' : 'Waiting for you to say yes'}
      </p>

      <div className={styles.anecdoteControls}>
        {!anecdote.approved ? (
          <form action={anecdoteAction} className={styles.inlineForm}>
            {hidden}
            <input type="hidden" name="action" value="approve" />
            <button type="submit" className={step.quiet}>
              Yes, keep it
            </button>
          </form>
        ) : null}

        <form action={anecdoteAction} className={styles.inlineForm}>
          {hidden}
          <input type="hidden" name="action" value="remove" />
          <button type="submit" className={step.quiet}>
            Remove
          </button>
        </form>
      </div>

      {/* Editing is also approving: rewriting it makes it theirs. */}
      <details>
        <summary className={step.quiet}>Not quite — let me put it my way</summary>
        <form action={anecdoteAction}>
          {hidden}
          <input type="hidden" name="action" value="edit" />
          <textarea
            className={styles.editArea}
            name="text"
            defaultValue={anecdote.text}
            aria-label="Your version of this memory"
          />
          <button type="submit" className={step.quiet}>
            Save my version
          </button>
        </form>
      </details>
    </>
  );
}
