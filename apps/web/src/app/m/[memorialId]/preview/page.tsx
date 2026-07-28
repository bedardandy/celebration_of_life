/**
 * Watching it, and changing it.
 *
 * The player is the same React composition the renderer uses, so what plays
 * here is what will play in the room. Underneath is one row per slide, and
 * every adjustment is a button — move it up, hold it a bit longer, use a
 * different photograph, take it out — because dragging things around a list is
 * the first interaction to fail for someone tired, on a phone, with a tremor.
 *
 * Nothing here is destructive. "Remove" takes a slide out of the video and
 * leaves it in the file, and the removed ones sit at the bottom waiting to be
 * put back.
 */
import Link from 'next/link';
import {
  NUDGE_SEC,
  approvedAssets,
  canNudgeSlide,
  describeLength,
  latestProject,
  previewView,
  projectEdl,
  summariseMusic,
  type PreviewSlideRow,
} from '@col/core';
import type { CutName, Slide } from '@col/schemas';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { CaptionField } from './CaptionField';
import { PreviewPlayer } from './PreviewPlayer';
import { WaitingRefresh } from './WaitingRefresh';
import {
  longerAction,
  moveDownAction,
  moveUpAction,
  removeSlideAction,
  restoreSlideAction,
  shorterAction,
  swapPhotoAction,
} from './actions';
import styles from './preview.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Watch it through' };

export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const cut: CutName = query['cut'] === 'service' ? 'service' : 'family';
  const project = latestProject(db(), memorialId);
  const edl = projectEdl(project);

  if (!edl) {
    return (
      <StepScreen
        eyebrow={`Remembering ${memorial.decedentName}`}
        title={`Putting ${memorial.decedentName.split(' ')[0]}'s story together`}
        helper="A minute or two. You do not have to stay on this page — it will be here when you come back."
        primary={
          <Link className={step.primary} href={`/m/${memorialId}`}>
            Back to the dashboard
          </Link>
        }
        secondary={<Link href={`/m/${memorialId}/story-shape`}>Choose a different shape</Link>}
        footer="Nothing is lost while this runs."
      >
        <WaitingRefresh />
      </StepScreen>
    );
  }

  const view = previewView(edl, cut);
  const music = summariseMusic(db(), project);
  const assets = approvedAssets(db(), memorialId);
  const assetUrlMap = Object.fromEntries(
    assets.map((asset) => [asset.id, `/api/assets/${asset.id}?variant=web1600`]),
  );

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Watch it through"
      helper={`${cut === 'service' ? 'The service cut' : 'The family cut'} — ${describeLength(view.timeline.totalSec)}, ${view.timeline.slides.length} slides.${music.decided ? ` ${music.line}` : ''}`}
      primary={
        // Once the music is settled there is exactly one thing left worth
        // doing, and it is not looking at this screen again.
        music.decided ? (
          <Link className={step.primary} href={`/m/${memorialId}/deliver`}>
            Looks good — make the video
          </Link>
        ) : (
          <Link className={step.primary} href={`/m/${memorialId}/music`}>
            Looks good — choose music next
          </Link>
        )
      }
      secondary={
        <>
          {music.decided ? <Link href={`/m/${memorialId}/music`}>Change the music</Link> : null}
          <Link href={`/m/${memorialId}/story-shape`}>Try a different shape</Link>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </>
      }
      footer="Every change here saves as you make it, and nothing is ever thrown away."
    >
      <PreviewPlayer
        edl={edl}
        timeline={view.timeline}
        assetUrlMap={assetUrlMap}
        edlVersion={project?.edlVersion ?? 0}
      />

      <CutToggle memorialId={memorialId} cut={cut} />

      {view.timeline.droppedSlideIds.length > 0 && cut === 'service' ? (
        <p className={styles.note}>
          {view.timeline.droppedSlideIds.length}{' '}
          {view.timeline.droppedSlideIds.length === 1 ? 'photo is' : 'photos are'} held back to fit
          five minutes. They are all still in the family version.
        </p>
      ) : null}

      <ol className={styles.list}>
        {view.rows.map((row) => (
          <SlideRow
            key={row.slideId}
            memorialId={memorialId}
            cut={cut}
            row={row}
            total={view.rows.length}
            assets={assets}
          />
        ))}
      </ol>

      {view.removed.length > 0 ? (
        <section className={styles.removed}>
          <h2 className={styles.removedTitle}>Taken out</h2>
          <p className={styles.removedHelp}>
            Still here, just not in the video. Put any of them back whenever you like.
          </p>
          <ul className={styles.removedList}>
            {view.removed.map((row) => (
              <li key={row.slideId} className={styles.removedItem}>
                <span>{describeSlide(row.slide)}</span>
                <form action={restoreSlideAction}>
                  <input type="hidden" name="memorialId" value={memorialId} />
                  <input type="hidden" name="slideId" value={row.slideId} />
                  <input type="hidden" name="cut" value={cut} />
                  <button type="submit" className={step.quiet}>
                    Put it back
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </StepScreen>
  );
}

function CutToggle({ memorialId, cut }: { memorialId: string; cut: CutName }) {
  return (
    <nav className={styles.cuts} aria-label="Which version to watch">
      <Link
        href={`/m/${memorialId}/preview`}
        className={`${styles.cutLink} ${cut === 'family' ? styles.cutActive : ''}`}
      >
        The family version
      </Link>
      <Link
        href={`/m/${memorialId}/preview?cut=service`}
        className={`${styles.cutLink} ${cut === 'service' ? styles.cutActive : ''}`}
      >
        The service version (about five minutes)
      </Link>
    </nav>
  );
}

type AssetRow = {
  id: string;
  caption: string | null;
  originalFilename: string | null;
};

function SlideRow({
  memorialId,
  cut,
  row,
  total,
  assets,
}: {
  memorialId: string;
  cut: CutName;
  row: PreviewSlideRow;
  total: number;
  assets: AssetRow[];
}) {
  const { slide } = row;
  const where = { memorialId, slideId: row.slideId, cut };

  return (
    <li className={styles.row} id={`slide-${row.slideId}`}>
      <div className={styles.thumb}>
        {slide.kind === 'photo' ? (
          <img
            src={`/api/assets/${slide.assetId}?variant=thumb320`}
            alt=""
            width={96}
            height={96}
            className={styles.thumbImg}
            loading="lazy"
          />
        ) : (
          <span className={styles.cardBadge}>{cardLabel(slide)}</span>
        )}
      </div>

      <div className={styles.body}>
        <p className={styles.rowTitle}>
          <span className={styles.chapter}>{row.chapterTitle}</span>
          {describeSlide(slide)}
        </p>
        <p className={styles.timing}>
          {row.startSec.toFixed(1)}s · on screen for {row.durationSec.toFixed(1)}s
          {row.inCut ? '' : ' · not in this version'}
        </p>

        {slide.kind === 'photo' ? (
          <CaptionField
            memorialId={memorialId}
            slideId={row.slideId}
            cut={cut}
            caption={slide.caption?.text ?? ''}
          />
        ) : null}

        <div className={styles.buttons}>
          <ActionButton action={moveUpAction} where={where} disabled={row.index === 0}>
            Move up
          </ActionButton>
          <ActionButton action={moveDownAction} where={where} disabled={row.index >= total - 1}>
            Move down
          </ActionButton>
          {slide.kind === 'photo' ? (
            <>
              <ActionButton
                action={longerAction}
                where={where}
                disabled={!canNudgeSlide(slide, NUDGE_SEC)}
              >
                A bit longer
              </ActionButton>
              <ActionButton
                action={shorterAction}
                where={where}
                disabled={!canNudgeSlide(slide, -NUDGE_SEC)}
              >
                A bit shorter
              </ActionButton>
            </>
          ) : null}
          <ActionButton action={removeSlideAction} where={where}>
            Remove
          </ActionButton>
        </div>

        {slide.kind === 'photo' ? (
          <details className={styles.swap}>
            <summary className={styles.swapSummary}>Use a different photo</summary>
            <ul className={styles.swapGrid}>
              {assets.map((asset) => (
                <li key={asset.id}>
                  <form action={swapPhotoAction}>
                    <Where where={where} />
                    <input type="hidden" name="assetId" value={asset.id} />
                    <button type="submit" className={styles.swapButton} title={asset.caption ?? ''}>
                      <img
                        src={`/api/assets/${asset.id}?variant=thumb320`}
                        alt={asset.caption ?? asset.originalFilename ?? 'A photo'}
                        width={72}
                        height={72}
                        loading="lazy"
                      />
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </li>
  );
}

type Where = { memorialId: string; slideId: string; cut: CutName };

/** Which slide, in which version — on every form, so actions need no state. */
function Where({ where }: { where: Where }) {
  return (
    <>
      <input type="hidden" name="memorialId" value={where.memorialId} />
      <input type="hidden" name="slideId" value={where.slideId} />
      <input type="hidden" name="cut" value={where.cut} />
    </>
  );
}

function ActionButton({
  action,
  where,
  disabled,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  where: Where;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <form action={action}>
      <Where where={where} />
      <button type="submit" className={styles.rowButton} disabled={disabled}>
        {children}
      </button>
    </form>
  );
}

function cardLabel(slide: Slide): string {
  switch (slide.kind) {
    case 'title':
      return 'Title';
    case 'quote':
      return 'Memory';
    case 'closing':
      return 'Closing';
    default:
      return 'Slide';
  }
}

function describeSlide(slide: Slide): string {
  switch (slide.kind) {
    case 'title':
      return slide.text;
    case 'quote':
      return `“${truncate(slide.text, 90)}” — ${slide.attribution}`;
    case 'closing':
      return slide.line1;
    case 'photo':
      return slide.caption?.text ?? 'A photograph';
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
