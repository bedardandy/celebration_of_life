/**
 * Going through the photos.
 *
 * The longest sitting-down job in the product, so the screen is built to be put
 * down: every tap saves, nothing needs finishing, and the order never changes
 * under someone's hand. Decades group the grid because that is how families
 * talk about photographs; near-duplicates collapse to one card because four
 * frames of one moment are one decision; blurry photos get a kind badge and
 * stay exactly where they are.
 */
import Link from 'next/link';
import {
  buildCurationView,
  duplicateCardLine,
  findCoverageGaps,
  noteCountsByAsset,
  primaryGap,
  UNKNOWN_ERA,
  type CurationCard,
  type EraGroup,
} from '@col/core';
import { and, eq, isNull, listWhere, mediaAssets, participants } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import {
  addNoteAction,
  chooseRepresentativeAction,
  toggleApprovalAction,
  toggleHiddenAction,
  toggleWhoIsThisAction,
} from './actions';
import styles from './curate.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Go through the photos' };

export default async function CuratePage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const assets = listWhere(
    db(),
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    2_000,
  );

  const contributorNames = new Map(
    listWhere(db(), participants, eq(participants.memorialId, memorialId))
      .filter((p) => p.displayName)
      .map((p) => [p.id, p.displayName as string]),
  );

  const view = buildCurationView({
    assets,
    contributorNames,
    noteCounts: noteCountsByAsset(db(), memorialId),
  });

  const countsByEra = new Map(view.groups.map((g) => [g.era, g.cards.length]));
  const gap = primaryGap(
    findCoverageGaps({
      birthYear: memorial.birthYear,
      deathYear: memorial.deathYear,
      countsByEra,
    }),
  );

  if (assets.length === 0) {
    return (
      <StepScreen
        eyebrow={`Remembering ${memorial.decedentName}`}
        title="No photos yet"
        helper="They will appear here as people add them — you do not have to wait on this screen."
        primary={
          <Link className={step.primary} href={`/m/${memorialId}/photos`}>
            Share the link with family
          </Link>
        }
        secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      />
    );
  }

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Go through the photos"
      helper="Tap a photo to keep it. Everything saves as you go, and nothing is ever deleted."
      footer={
        <div className={styles.footerRow}>
          <span>{view.summary}</span>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </div>
      }
    >
      <p className={styles.summary}>{view.summary}</p>

      {gap ? (
        <aside className={styles.nudge}>
          <p className={styles.nudgeText}>{gap.message}</p>
          <Link className={styles.nudgeLink} href={`/m/${memorialId}/photos#delegate`}>
            Ask someone for photos from {gap.era === UNKNOWN_ERA ? 'then' : `the ${gap.era}`}
          </Link>
        </aside>
      ) : null}

      {view.counts.problems > 0 ? (
        <p className={styles.problemNote}>
          {view.counts.problems === 1 ? 'One file' : `${view.counts.problems} files`} could not be
          opened. They are marked below, and nothing else was affected.
        </p>
      ) : null}

      {view.groups.map((group) => (
        <EraSection key={group.era} memorialId={memorialId} group={group} />
      ))}
    </StepScreen>
  );
}

function EraSection({ memorialId, group }: { memorialId: string; group: EraGroup }) {
  return (
    <section className={styles.era}>
      <h2 className={styles.eraTitle}>
        {group.label}
        <span className={styles.eraCount}>
          {group.cards.length} {group.cards.length === 1 ? 'photo' : 'photos'}
        </span>
      </h2>
      <ul className={styles.grid}>
        {group.cards.map((card) => (
          <PhotoCard key={card.asset.id} memorialId={memorialId} card={card} />
        ))}
      </ul>
    </section>
  );
}

function PhotoCard({ memorialId, card }: { memorialId: string; card: CurationCard }) {
  const { asset } = card;
  const isVideo = asset.mime.startsWith('video/');
  const label = asset.originalFilename ?? 'A photo someone added';

  return (
    <li
      className={`${styles.card} ${card.approved ? styles.cardApproved : ''} ${
        card.hidden ? styles.cardHidden : ''
      }`}
      id={`photo-${asset.id}`}
    >
      <form action={toggleApprovalAction} className={styles.tapForm}>
        <input type="hidden" name="memorialId" value={memorialId} />
        <input type="hidden" name="assetId" value={asset.id} />
        <button
          type="submit"
          className={styles.tapButton}
          aria-pressed={card.approved}
          // The picture's alt text names the photograph; the button also has to
          // say what pressing it does, which a screen reader would otherwise
          // have to infer from a filename.
          aria-label={card.approved ? `Keeping ${label}` : `Keep ${label}`}
          title={card.approved ? 'Keeping this one' : 'Tap to keep this one'}
        >
          {card.problem ? (
            <span className={styles.problem}>{card.problem}</span>
          ) : isVideo ? (
            <span className={styles.video}>Video — kept as it is</span>
          ) : (
            <img
              className={styles.thumb}
              src={`/api/assets/${asset.id}?variant=thumb320`}
              alt={label}
              width={160}
              height={160}
              loading="lazy"
            />
          )}
          <span className={styles.check} aria-hidden="true">
            {card.approved ? '✓' : ''}
          </span>
        </button>
      </form>

      <div className={styles.meta}>
        {card.approved ? <span className={styles.kept}>Keeping</span> : null}
        {card.hidden ? <span className={styles.hiddenTag}>Hidden</span> : null}
        {card.badge ? <span className={styles.badge}>{card.badge}</span> : null}
        {card.needsIdentification ? <span className={styles.badge}>Who is this?</span> : null}
        {card.contributorName ? (
          <span className={styles.from}>from {card.contributorName}</span>
        ) : null}
        {card.noteCount > 0 ? (
          <span className={styles.from}>
            {card.noteCount} {card.noteCount === 1 ? 'note' : 'notes'}
          </span>
        ) : null}
      </div>

      {card.alternates.length > 0 ? (
        <details className={styles.dupes}>
          <summary className={styles.dupesSummary}>
            {duplicateCardLine(card.alternates.length)} See all
          </summary>
          <ul className={styles.dupeList}>
            {card.alternates.map((alternate) => (
              <li key={alternate.id} className={styles.dupeItem}>
                <img
                  className={styles.dupeThumb}
                  src={`/api/assets/${alternate.id}?variant=thumb320`}
                  alt={alternate.originalFilename ?? 'Another photo of the same moment'}
                  width={72}
                  height={72}
                  loading="lazy"
                />
                <form action={chooseRepresentativeAction}>
                  <input type="hidden" name="memorialId" value={memorialId} />
                  <input type="hidden" name="assetId" value={alternate.id} />
                  <button type="submit" className={step.quiet}>
                    Show this one instead
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <details className={styles.menu}>
        <summary className={styles.menuSummary}>More</summary>
        <div className={styles.menuBody}>
          <form action={toggleHiddenAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="assetId" value={asset.id} />
            <button type="submit" className={step.quiet}>
              {card.hidden ? 'Put it back' : 'Hide this one'}
            </button>
          </form>

          <form action={toggleWhoIsThisAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="assetId" value={asset.id} />
            <button type="submit" className={step.quiet}>
              {card.needsIdentification ? 'Never mind who' : 'Who is this?'}
            </button>
          </form>

          <form action={addNoteAction} className={styles.noteForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="assetId" value={asset.id} />
            <label htmlFor={`note-${asset.id}`}>Add a note</label>
            <textarea
              id={`note-${asset.id}`}
              name="note"
              rows={2}
              className={styles.noteField}
              placeholder="Anything worth remembering about this one"
            />
            <button type="submit" className={step.quiet}>
              Save this note
            </button>
          </form>
        </div>
      </details>
    </li>
  );
}
