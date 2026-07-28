/**
 * Music chosen — and the slideshow re-timed to it.
 *
 * A confirmation screen exists here for one reason: choosing music silently
 * changed where every slide turns over, and a person who is not told that will
 * not think to go and watch it again. So this says what changed, and offers the
 * two things worth doing next in the order most families want them.
 */
import Link from 'next/link';
import { describeLength, latestProject, projectCut, projectEdl, summariseMusic } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { reopenMusicAction } from '../actions';
import styles from '../music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Music chosen' };

export default async function MusicChosenPage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const project = latestProject(db(), memorialId);
  const summary = summariseMusic(db(), project);
  const edl = projectEdl(project);
  const snapped = edl?.audio.beatGrid != null;
  const service = edl ? projectCut(edl, 'service') : undefined;

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="That is the music sorted"
      helper={summary.line}
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/deliver`}>
          Make the video
        </Link>
      }
      secondary={
        <>
          <Link href={`/m/${memorialId}/preview`}>Watch it through first</Link>
          <form action={reopenMusicAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <button type="submit" className={step.quiet}>
              Choose different music
            </button>
          </form>
        </>
      }
      footer="Nothing is final. You can change the music at any point before you download the video."
    >
      <ul className={styles.guidanceList}>
        {snapped ? (
          <li>
            The slideshow has been re-timed: pictures now change where the music turns over rather
            than at arbitrary moments.
          </li>
        ) : (
          <li>
            The slideshow keeps its own timing. Without a tempo we do not guess at one — the pacing
            stays even instead.
          </li>
        )}
        {service ? (
          <li>
            The service version runs {describeLength(service.totalSec)}, over{' '}
            {service.slides.length} slides.
          </li>
        ) : null}
        {summary.mode === 'sideloaded' ? (
          <li>
            When the video is ready you will get a printable card for the venue: which song, when to
            start it, and what to check beforehand.
          </li>
        ) : (
          <li>
            The music is mixed into the file, faded in and out, and levelled so it is not loud.
          </li>
        )}
      </ul>
    </StepScreen>
  );
}
