/**
 * "Where or when was this?"
 *
 * Asked once, about the photos that just arrived, with the photos in front of
 * them — which is the only moment anybody can answer it. Every box is optional
 * and the whole screen is skippable in one tap, because the photo is the thing
 * we actually need and a note is a bonus.
 */
import { and, eq, inArray, isNull, listWhere, mediaAssets } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { readBatch, resolveToken } from '@/server/contributor';
import { LinkClosed } from '../LinkClosed';
import { saveNotesAction, skipToThanksAction } from '../actions';
import styles from '../contributor.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Anything you remember?' };

export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const resolved = resolveToken(token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial } = resolved.context;
  const name = memorial.decedentKnownAs || memorial.decedentName;
  const batch = await readBatch(resolved.context.token.id);

  const assets =
    batch.length === 0
      ? []
      : listWhere(
          db(),
          mediaAssets,
          and(
            eq(mediaAssets.memorialId, memorial.id),
            inArray(mediaAssets.id, batch),
            isNull(mediaAssets.deletedAt),
          ),
        );

  const added = Number(query['added'] ?? assets.length) || assets.length;
  const skipped = Number(query['skipped'] ?? 0) || 0;

  return (
    <StepScreen
      eyebrow={`For ${name}`}
      title={added > 0 ? `${added} added. Thank you.` : 'Anything you remember?'}
      helper={
        assets.length > 0
          ? 'If you remember where or when one of these was taken, it helps the family. All of this is optional.'
          : 'Nothing to add notes to just now.'
      }
      footer="Nothing here is required. The photos are already safe with the family."
    >
      {skipped > 0 ? (
        <p className={styles.notice}>
          {skipped === 1 ? 'One file' : `${skipped} files`} could not be added. Photos and videos
          work best.
        </p>
      ) : null}

      <form action={saveNotesAction} className={styles.stack}>
        <input type="hidden" name="token" value={token} />
        {assets.length > 0 ? (
          <ul className={styles.noteList}>
            {assets.map((asset) => (
              <li key={asset.id} className={styles.noteItem}>
                {/* A photo is only shown once its small copy exists. Straight
                    after an upload it usually does not yet, and a broken image
                    icon is the last thing somebody should see having just sent
                    their photographs. */}
                {asset.ingestState === 'ready' ? (
                  <img
                    className={styles.noteThumb}
                    src={`/api/assets/${asset.id}?variant=thumb320&token=${encodeURIComponent(token)}`}
                    alt={asset.originalFilename ?? 'A photo you just added'}
                    width={96}
                    height={96}
                    loading="lazy"
                  />
                ) : (
                  <span className={styles.notePending} aria-hidden="true" />
                )}
                <div>
                  <label htmlFor={`note-${asset.id}`}>
                    Where or when was this? Anything you remember?
                  </label>
                  <textarea
                    id={`note-${asset.id}`}
                    name={`note-${asset.id}`}
                    className={styles.noteField}
                    rows={3}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <button type="submit" className={step.primary}>
            {assets.length > 0 ? 'Save and continue' : 'Continue'}
          </button>
        </div>
      </form>

      <form action={skipToThanksAction} style={{ marginTop: '24px' }}>
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={step.quiet}>
          Skip this
        </button>
      </form>
    </StepScreen>
  );
}
