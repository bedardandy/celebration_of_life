/**
 * The last screen.
 *
 * Everything before this was about making something; this is about a person
 * getting a file onto a stick and into a room, probably the night before,
 * probably tired. So the screen is arranged around the three things that
 * actually go wrong:
 *
 *  - the wrong length ("the service one is five minutes; the family one has
 *    everything in it"),
 *  - the wait ("this takes 5–15 minutes; you can close this page"),
 *  - the venue ("test it on their machine, here is a card for the director").
 *
 * There is exactly one primary button, and it is the final video. The quick
 * preview is quiet and next to it, because a draft is a useful thing to want
 * and a terrible thing to take to a funeral by mistake.
 */
import Link from 'next/link';
import type { CutName, RenderPreset } from '@col/schemas';
import {
  RENDER_PRESET_LABELS,
  USB_STEPS,
  deliverableFilename,
  describeLength,
  describeRenderProgress,
  latestProject,
  latestRender,
  projectCut,
  projectEdl,
  summariseMusic,
} from '@col/core';
import { getPack } from '@col/tradition-packs';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { RenderWatch } from './RenderWatch';
import { startRenderAction } from './actions';
import styles from './deliver.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The finished video' };

export default async function DeliverPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const cut: CutName = query['cut'] === 'family' ? 'family' : 'service';
  const project = latestProject(db(), memorialId);
  const edl = projectEdl(project);

  if (!edl) {
    return (
      <StepScreen
        eyebrow={`Remembering ${memorial.decedentName}`}
        title="The slideshow is not ready yet"
        helper="Once there is something to watch, this is where you make the file."
        primary={
          <Link className={step.primary} href={`/m/${memorialId}/slideshow`}>
            Go to the slideshow
          </Link>
        }
        secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      />
    );
  }

  const timeline = projectCut(edl, cut);
  const music = summariseMusic(db(), project);
  const pack = getPack(memorial.traditionSlug);
  const placement = pack.mediaPlacement[0];

  const finals: { preset: RenderPreset }[] = [
    { preset: 'final1080' },
    { preset: 'backup720' },
    { preset: 'draft360' },
  ];
  const rows = finals
    .map(({ preset }) => {
      const job = latestRender(db(), memorialId, cut, preset);
      return job ? { preset, job, progress: describeRenderProgress(job) } : undefined;
    })
    .filter((row) => row !== undefined);

  const working = rows.some((row) => row.progress.working);
  const ready = rows.filter((row) => row.progress.done && row.job.outputBlobKey);

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="The finished video"
      helper={`${cut === 'service' ? 'The service version' : 'The family version'} — ${describeLength(
        timeline.totalSec,
      )}, ${timeline.slides.length} slides. ${music.line}`}
      primary={
        <form action={startRenderAction} className={styles.primaryForm}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="cut" value={cut} />
          <input type="hidden" name="preset" value="final1080" />
          <label className={styles.backupToggle}>
            <input type="checkbox" name="backup" value="yes" defaultChecked />
            <span>Also make a smaller 720p copy, in case the venue’s machine struggles</span>
          </label>
          <button type="submit" className={step.primary}>
            {ready.length > 0 ? 'Make it again' : 'Prepare the final video'}
          </button>
        </form>
      }
      secondary={
        <>
          <form action={startRenderAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="cut" value={cut} />
            <input type="hidden" name="preset" value="draft360" />
            <button type="submit" className={step.quiet}>
              Quick preview render (small and fast)
            </button>
          </form>
          <Link href={`/m/${memorialId}/preview`}>Change something first</Link>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </>
      }
      footer="Making a video usually takes about 5–15 minutes — longer for a long one, or on a busy machine. You can close this page: we keep working, and the files will be here when you come back."
    >
      <RenderWatch active={working} />

      <CutChoice memorialId={memorialId} cut={cut} />

      {query['started'] === '1' && working ? (
        <p className={styles.started}>
          Started. You do not have to stay here — nothing is lost if you close the page.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className={styles.empty}>
          Nothing has been made for this version yet. The final video is the one to make; the quick
          preview is only for checking the order of things.
        </p>
      ) : (
        <ul className={styles.renders}>
          {rows.map(({ preset, job, progress }) => {
            const filename = deliverableFilename({
              decedentName: memorial.decedentName,
              cut,
              preset,
            });
            return (
              <li key={job.id} className={styles.render}>
                <div className={styles.renderHead}>
                  <p className={styles.renderTitle}>{RENDER_PRESET_LABELS[preset]}</p>
                  <p className={styles.renderMeta}>
                    {job.durationSec
                      ? describeLength(job.durationSec)
                      : describeLength(timeline.totalSec)}
                    {job.ffprobeMeta && typeof job.ffprobeMeta === 'object'
                      ? ` · ${(job.ffprobeMeta as { width?: number }).width ?? ''}×${
                          (job.ffprobeMeta as { height?: number }).height ?? ''
                        }`
                      : ''}
                  </p>
                </div>

                {progress.done && job.outputBlobKey ? (
                  <div className={styles.renderActions}>
                    <a className={step.primary} href={`/api/renders/${job.id}`} download={filename}>
                      Download
                    </a>
                    <p className={styles.filename}>{filename}</p>
                  </div>
                ) : (
                  <div className={styles.renderProgress}>
                    <div
                      className={styles.bar}
                      role="progressbar"
                      aria-valuenow={progress.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="How far through the video is"
                    >
                      <span className={styles.barFill} style={{ width: `${progress.percent}%` }} />
                    </div>
                    <p className={progress.failed ? styles.problem : styles.progressLine}>
                      {progress.message}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {ready.length > 0 ? (
        <section className={styles.guides}>
          <h2 className={styles.guidesTitle}>Getting it into the room</h2>

          <details className={styles.accordion}>
            <summary className={styles.summary}>Putting it on a USB stick</summary>
            <ol className={styles.steps}>
              {USB_STEPS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </details>

          <details className={styles.accordion} open>
            <summary className={styles.summary}>For the funeral director</summary>
            <p className={styles.guideBody}>
              A single printable page: the file name, how long it runs, what format it is, and a
              request to test it before the service.
            </p>
            <p>
              <Link
                className={styles.guideLink}
                href={`/m/${memorialId}/deliver/card?cut=${cut}&preset=${ready[0]?.preset ?? 'final1080'}`}
              >
                Open the card to print
              </Link>
            </p>
          </details>

          {music.mode === 'sideloaded' ? (
            <details className={styles.accordion} open>
              <summary className={styles.summary}>For whoever plays the song</summary>
              <p className={styles.guideBody}>
                This video is silent on purpose. Somebody in the room presses play on the song — the
                timing card tells them which song, when to start it, and that a few seconds either
                way is fine.
              </p>
              <p>
                <Link
                  className={styles.guideLink}
                  href={`/m/${memorialId}/deliver/timing-card?cut=${cut}`}
                >
                  Open the timing card
                </Link>
              </p>
            </details>
          ) : null}

          {placement ? (
            <details className={styles.accordion}>
              <summary className={styles.summary}>{placement.context}</summary>
              <p className={styles.guideBody}>{placement.guidance}</p>
            </details>
          ) : null}

          {pack.deliveryNotes.length > 0 ? (
            <details className={styles.accordion}>
              <summary className={styles.summary}>Notes for this kind of service</summary>
              <ul className={styles.steps}>
                {pack.deliveryNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </StepScreen>
  );
}

/**
 * Which version. The service cut is preselected everywhere, because it is the
 * one with a room and a time attached to it.
 */
function CutChoice({ memorialId, cut }: { memorialId: string; cut: CutName }) {
  return (
    <nav className={styles.cuts} aria-label="Which version to make">
      <Link
        href={`/m/${memorialId}/deliver?cut=service`}
        className={`${styles.cutLink} ${cut === 'service' ? styles.cutActive : ''}`}
      >
        For the service — about five minutes
      </Link>
      <Link
        href={`/m/${memorialId}/deliver?cut=family`}
        className={`${styles.cutLink} ${cut === 'family' ? styles.cutActive : ''}`}
      >
        For the family — everything in it
      </Link>
    </nav>
  );
}
