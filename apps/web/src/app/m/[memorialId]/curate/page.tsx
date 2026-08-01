/**
 * Going through the photos.
 *
 * The longest sitting-down job in the product, so the screen is built to be put
 * down: every tap saves, nothing needs finishing, and the order never changes
 * under someone's hand. Decades group the grid because that is how families
 * talk about photographs; near-duplicates collapse to one card because four
 * frames of one moment are one decision; blurry photos get a kind badge and
 * stay exactly where they are.
 *
 * Two optional things live here as well, and both are absent unless somebody
 * asked for them: groups of the same face (only when an engine is installed on
 * this machine) and a gently improved copy of one photograph (only when
 * somebody presses "improve this photo", and never in place of the original).
 */
import Link from 'next/link';
import {
  buildCurationView,
  duplicateCardLine,
  enhancementViews,
  faceChipLabel,
  facesView,
  findCoverageGaps,
  findNamedFace,
  noteCountsByAsset,
  personCoverage,
  primaryGap,
  ENHANCE_COPY,
  FACE_GROUPING_COPY,
  UNKNOWN_ERA,
  type ClusterSummary,
  type CurationCard,
  type EnhancementView,
  type EraGroup,
  type FacesView,
  type NamedFace,
} from '@col/core';
import { and, eq, isNull, listWhere, mediaAssets, participants } from '@col/db';
import { faceEngineConfigured } from '@col/media';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import {
  addNoteAction,
  chooseRepresentativeAction,
  dismissClusterAction,
  improvePhotoAction,
  keepOriginalAction,
  nameClusterAction,
  startFaceGroupingAction,
  toggleApprovalAction,
  toggleHiddenAction,
  toggleWhoIsThisAction,
  useImprovedAction,
} from './actions';
import styles from './curate.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Go through the photos' };

export default async function CuratePage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
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

  // Faces are only ever a filter and a suggestion. When no engine is installed
  // on this machine, `facesView` says 'unavailable' and none of this renders.
  const faces = facesView(db(), memorial, { engineConfigured: faceEngineConfigured() });
  const personId = typeof query['person'] === 'string' ? query['person'] : undefined;
  const person = personId ? findNamedFace(db(), memorialId, personId) : undefined;

  const shown = person ? assets.filter((asset) => person.assetIds.includes(asset.id)) : assets;

  const view = buildCurationView({
    assets: shown,
    contributorNames,
    noteCounts: noteCountsByAsset(db(), memorialId),
  });
  const enhancements = enhancementViews(db(), shown);

  const countsByEra = new Map(view.groups.map((g) => [g.era, g.cards.length]));
  const gap = person
    ? personCoverage(db(), memorial, person).gap
    : primaryGap(
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

      <Faces
        memorialId={memorialId}
        faces={faces}
        selectedPersonId={personId}
        justStarted={query['faces'] === 'started'}
      />

      {view.counts.problems > 0 ? (
        <p className={styles.problemNote}>
          {view.counts.problems === 1 ? 'One file' : `${view.counts.problems} files`} could not be
          opened. They are marked below, and nothing else was affected.
        </p>
      ) : null}

      {person ? (
        <p className={styles.problemNote}>
          Showing the {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'} with{' '}
          {person.name} in {person.photoCount === 1 ? 'it' : 'them'}.{' '}
          <Link href={`/m/${memorialId}/curate`}>Show everyone again</Link>
        </p>
      ) : null}

      {view.groups.map((group) => (
        <EraSection
          key={group.era}
          memorialId={memorialId}
          group={group}
          enhancements={enhancements}
        />
      ))}
    </StepScreen>
  );
}

/* -------------------------------------------------------------------------- */
/* faces                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Absent, offered, working, or a strip of gentle suggestions.
 *
 * The consent sentence is on the card with the button, not in a settings page
 * somebody will never open, because that is the moment a person is deciding.
 */
function Faces({
  memorialId,
  faces,
  selectedPersonId,
  justStarted,
}: {
  memorialId: string;
  faces: FacesView;
  selectedPersonId?: string;
  justStarted: boolean;
}) {
  if (faces.state === 'unavailable') return null;

  if (faces.state === 'offer') {
    return (
      <section className={styles.faces} id="faces">
        <h2 className={styles.facesTitle}>{FACE_GROUPING_COPY.title}</h2>
        <p className={styles.facesBody}>{FACE_GROUPING_COPY.body}</p>
        <form action={startFaceGroupingAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <button type="submit" className={step.quiet}>
            {FACE_GROUPING_COPY.start}
          </button>
        </form>
      </section>
    );
  }

  if (faces.state === 'working') {
    return (
      <section className={styles.faces} id="faces">
        <p className={styles.facesBody}>{FACE_GROUPING_COPY.working}</p>
      </section>
    );
  }

  const nothingYet = faces.suggestions.length === 0 && faces.named.length === 0;

  return (
    <section className={styles.faces} id="faces">
      {justStarted ? <p className={styles.facesBody}>{FACE_GROUPING_COPY.working}</p> : null}

      {faces.named.length > 0 ? (
        <div className={styles.chips}>
          <Link
            className={`${styles.chip} ${selectedPersonId ? '' : styles.chipOn}`}
            href={`/m/${memorialId}/curate`}
          >
            {FACE_GROUPING_COPY.everyone}
          </Link>
          {faces.named.map((face: NamedFace) => (
            <Link
              key={face.personId}
              className={`${styles.chip} ${selectedPersonId === face.personId ? styles.chipOn : ''}`}
              href={`/m/${memorialId}/curate?person=${face.personId}`}
            >
              {faceChipLabel(face)}
            </Link>
          ))}
        </div>
      ) : null}

      {faces.suggestions.map((cluster) => (
        <ClusterStrip key={cluster.clusterId} memorialId={memorialId} cluster={cluster} />
      ))}

      {nothingYet ? <p className={styles.facesBody}>{FACE_GROUPING_COPY.nothing}</p> : null}

      {faces.pendingPhotos > 0 ? (
        <form action={startFaceGroupingAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <button type="submit" className={step.quiet}>
            {FACE_GROUPING_COPY.again}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/**
 * One suggestion: a handful of faces, a box to name them, and a way to say no.
 *
 * The thumbnails are the whole photograph rather than a cropped face. Cropping
 * to a rectangle a model drew is how a family ends up looking at half a chin,
 * and the photograph itself is what they recognise.
 */
function ClusterStrip({ memorialId, cluster }: { memorialId: string; cluster: ClusterSummary }) {
  const inputId = `name-${cluster.clusterId}`;
  return (
    <div className={styles.cluster}>
      <p className={styles.clusterPrompt}>
        {FACE_GROUPING_COPY.clusterPrompt} — {cluster.photoCount}{' '}
        {cluster.photoCount === 1 ? 'photo' : 'photos'}
      </p>
      <ul className={styles.clusterFaces}>
        {cluster.samples.map((sample, index) => (
          <li key={`${sample.assetId}-${index}`}>
            <img
              className={styles.clusterThumb}
              src={`/api/assets/${sample.assetId}?variant=thumb320`}
              alt="One of the photos this face appears in"
              width={72}
              height={72}
              loading="lazy"
            />
          </li>
        ))}
      </ul>
      <div className={styles.clusterActions}>
        <form action={nameClusterAction} className={styles.clusterName}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="clusterId" value={cluster.clusterId} />
          <label htmlFor={inputId}>{FACE_GROUPING_COPY.nameLabel}</label>
          <input
            id={inputId}
            name="name"
            type="text"
            placeholder={FACE_GROUPING_COPY.namePlaceholder}
          />
          <button type="submit" className={step.quiet}>
            {FACE_GROUPING_COPY.nameButton}
          </button>
        </form>
        <form action={dismissClusterAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="clusterId" value={cluster.clusterId} />
          <button type="submit" className={step.quiet}>
            {FACE_GROUPING_COPY.dismiss}
          </button>
        </form>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the grid                                                                    */
/* -------------------------------------------------------------------------- */

function EraSection({
  memorialId,
  group,
  enhancements,
}: {
  memorialId: string;
  group: EraGroup;
  enhancements: Map<string, EnhancementView>;
}) {
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
          <PhotoCard
            key={card.asset.id}
            memorialId={memorialId}
            card={card}
            enhancement={enhancements.get(card.asset.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function PhotoCard({
  memorialId,
  card,
  enhancement,
}: {
  memorialId: string;
  card: CurationCard;
  enhancement?: EnhancementView;
}) {
  const { asset } = card;
  const isVideo = asset.mime.startsWith('video/');
  const label = asset.originalFilename ?? 'A photo someone added';
  const shownVariant = enhancement?.accepted ? 'enhanced2400' : 'thumb320';

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
              src={`/api/assets/${asset.id}?variant=${shownVariant}`}
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
        {enhancement?.badge ? <span className={styles.badge}>{enhancement.badge}</span> : null}
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

          {!isVideo && !card.problem ? (
            <Improve memorialId={memorialId} assetId={asset.id} enhancement={enhancement} />
          ) : null}

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

/**
 * The before and after.
 *
 * Two pictures side by side and two buttons — no slider, no drag, nothing that
 * needs a steady hand or a mouse. The original is the default and stays the
 * default until somebody chooses otherwise, and the sentence under the buttons
 * says the choice can be changed.
 */
function Improve({
  memorialId,
  assetId,
  enhancement,
}: {
  memorialId: string;
  assetId: string;
  enhancement?: EnhancementView;
}) {
  const state = enhancement?.state ?? 'none';

  if (state === 'queued') {
    return <p className={styles.improveNote}>{ENHANCE_COPY.working}</p>;
  }

  if (!enhancement?.hasCopy) {
    return (
      <form action={improvePhotoAction}>
        <input type="hidden" name="memorialId" value={memorialId} />
        <input type="hidden" name="assetId" value={assetId} />
        <button type="submit" className={step.quiet}>
          {ENHANCE_COPY.start}
        </button>
        {state === 'failed' ? <p className={styles.improveNote}>{ENHANCE_COPY.failed}</p> : null}
      </form>
    );
  }

  return (
    <div className={styles.improve}>
      <p className={styles.improveTitle}>{ENHANCE_COPY.compareTitle}</p>
      <div className={styles.compare}>
        <figure className={styles.compareItem}>
          <img
            className={styles.compareImage}
            src={`/api/assets/${assetId}?variant=web1600`}
            alt="The photo as it arrived"
            width={140}
            height={140}
            loading="lazy"
          />
          <figcaption>{ENHANCE_COPY.before}</figcaption>
        </figure>
        <figure className={styles.compareItem}>
          <img
            className={styles.compareImage}
            src={`/api/assets/${assetId}?variant=enhanced2400`}
            alt="The gently improved copy"
            width={140}
            height={140}
            loading="lazy"
          />
          <figcaption>{ENHANCE_COPY.after}</figcaption>
        </figure>
      </div>

      {enhancement.note ? <p className={styles.improveNote}>{enhancement.note}</p> : null}

      <div className={styles.improveActions}>
        {enhancement.accepted ? (
          <form action={keepOriginalAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="assetId" value={assetId} />
            <button type="submit" className={step.quiet}>
              {ENHANCE_COPY.keep}
            </button>
          </form>
        ) : (
          <form action={useImprovedAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="assetId" value={assetId} />
            <button type="submit" className={step.quiet}>
              {ENHANCE_COPY.accept}
            </button>
          </form>
        )}
      </div>
      <p className={styles.improveNote}>{ENHANCE_COPY.reassurance}</p>
    </div>
  );
}
