/**
 * One decision: whose music, and what that costs.
 *
 * This is the screen where a product usually shows a wall of legal text, and
 * where a grieving family usually gives up and does something that will get the
 * video taken off Facebook. So there is no legal text. There are two cards that
 * each say what the family gets and what they give up, in the order they care
 * about: can I share this, and can I have her song.
 *
 * The honest version of the second answer — the video stays silent and the room
 * plays the song — is genuinely how funeral homes do this already. Saying so
 * plainly is what makes it feel like a normal choice rather than a restriction.
 */
import Link from 'next/link';
import { latestProject, musicGuidanceFor, summariseMusic } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { chooseModeAction } from './actions';
import styles from './music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Music' };

export default async function MusicPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const project = latestProject(db(), memorialId);
  const current = summariseMusic(db(), project);
  const guidance = musicGuidanceFor(memorial.traditionSlug);

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="How should the music work?"
      helper="Two ways, and neither is better. The difference is only whether the song is inside the video file."
      secondary={
        <>
          <Link href={`/m/${memorialId}/preview`}>Back to the slideshow</Link>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </>
      }
      footer="You can change this later, and changing it does not lose any of your work."
    >
      {current.decided ? <p className={styles.current}>Right now: {current.line}</p> : null}

      <div className={styles.modes}>
        <form action={chooseModeAction} className={styles.modeForm}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="mode" value="cleared" />
          <button type="submit" className={styles.mode}>
            <span className={styles.modeTitle}>Use music we include</span>
            <span className={styles.modeLead}>
              The finished video can be shared anywhere, including online.
            </span>
            <span className={styles.modeBody}>
              Quiet instrumental pieces, written for this and free of any copyright. The music is
              inside the file, so you can email the video, put it on a memorial page, or hand it to
              the funeral director on a stick and know it will simply play.
            </span>
            <span className={styles.modeAlso}>
              You can also use a recording your family owns — someone playing the piano, a choir
              your mother sang in.
            </span>
          </button>
        </form>

        <form action={chooseModeAction} className={styles.modeForm}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="mode" value="sideloaded" />
          <button type="submit" className={styles.mode}>
            <span className={styles.modeTitle}>Time it to their song</span>
            <span className={styles.modeLead}>
              We pace the video to a song you choose — but the video itself stays silent.
            </span>
            <span className={styles.modeBody}>
              The song is played out loud in the room while the video plays. This is how funeral
              homes do it, and it avoids the copyright problem that stops a video with a commercial
              song on it from being shared afterwards.
            </span>
            <span className={styles.modeAlso}>
              We give the venue a printed card saying which song, and when to start it.
            </span>
          </button>
        </form>
      </div>

      {guidance.length > 0 ? (
        <aside className={styles.guidance}>
          <h2 className={styles.guidanceTitle}>About music at this kind of service</h2>
          <ul className={styles.guidanceList}>
            {guidance.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </aside>
      ) : null}

      <p className={styles.footnote}>
        Why the difference? Putting a commercial recording inside a video you then share needs a
        licence for that song, arranged one song at a time. Nobody can do that for you in three
        days, and pretending otherwise is how families end up with a video that gets muted or taken
        down.{' '}
        <Link className={step.quiet} href={`/m/${memorialId}/music/their-song`}>
          See what we would ask the venue to do
        </Link>
      </p>
    </StepScreen>
  );
}
