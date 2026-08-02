/**
 * Their song, played in the room.
 *
 * We ask for three things and only the first is required: what the song is, who
 * it is by, and — if they can manage it — the tempo, tapped along to whatever is
 * playing on their phone. The tempo is the difference between slides that
 * change with the music and slides that change near it, and it is genuinely
 * optional: a family who does not want to tap still gets a video.
 *
 * Nothing about the recording itself is uploaded, stored or analysed. That is
 * exactly why this mode exists.
 *
 * Above the fields there is a search box that plays half a minute of each
 * candidate, because "Danny Boy" is nine different recordings and the family
 * means one of them. It is a helper and never a gate: it can be ignored
 * entirely, it fills in the same two fields anybody could type, and when the
 * catalogue cannot be reached it shrinks to one sentence and gets out of the
 * way. Nothing it plays is kept, mixed in, or timed to.
 */
import Link from 'next/link';
import { latestProject, musicChoice } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { TapTempo } from '../TapTempo';
import { SongAudition } from '../SongAudition';
import { chooseSideloadedAction } from '../actions';
import styles from '../music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Their song' };

export default async function TheirSongPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const choice = musicChoice(db(), latestProject(db(), memorialId));
  const selection = choice.mode === 'sideloaded' ? choice.selection : undefined;

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Which song will the room hear?"
      helper="The video will be silent and paced to this song. Someone plays it out loud while the video runs."
      secondary={
        <>
          <Link href={`/m/${memorialId}/music/included`}>Use music we include instead</Link>
          <Link href={`/m/${memorialId}/music`}>Back a step</Link>
        </>
      }
      footer="We never receive the recording. We only write the song's name on the card the venue gets."
    >
      {query['problem'] === 'no-title' ? (
        <p className={styles.problem}>
          The song needs a name, so the venue knows what to play. Anything they will recognise is
          fine.
        </p>
      ) : null}

      <form action={chooseSideloadedAction} className={styles.form}>
        <input type="hidden" name="memorialId" value={memorialId} />

        <div>
          <p className={styles.auditionLead}>
            What was their song? Search, and listen to half a minute to be sure it is the right
            version. Or skip this and type the name yourself — both end up in the same place.
          </p>
          <SongAudition titleFieldId="title" artistFieldId="artist" />
        </div>

        <div>
          <label className={styles.label} htmlFor="title">
            The song
          </label>
          <input
            id="title"
            name="title"
            type="text"
            className={styles.input}
            maxLength={200}
            required
            defaultValue={selection?.sideloadedTitle ?? ''}
            placeholder="Danny Boy"
          />
        </div>

        <div>
          <label className={styles.label} htmlFor="artist">
            Whose version, if it matters
          </label>
          <input
            id="artist"
            name="artist"
            type="text"
            className={styles.input}
            maxLength={200}
            defaultValue={selection?.sideloadedArtist ?? ''}
            placeholder="The one from the kitchen radio"
          />
          <p className={styles.hint}>
            Optional. It helps whoever is pressing play find the right recording.
          </p>
        </div>

        <div>
          <span className={styles.label}>The tempo, if you can</span>
          <TapTempo />
          <p className={styles.hint}>
            Optional. If you tap it, the slides will change with the music instead of near it.
          </p>
        </div>

        <div>
          <label className={styles.label} htmlFor="songSec">
            How long is the song?
          </label>
          <input
            id="songSec"
            name="songSec"
            type="number"
            inputMode="numeric"
            min={30}
            max={1800}
            step={5}
            className={styles.input}
            placeholder="240"
          />
          <p className={styles.hint}>
            In seconds, roughly. Only used to work out where the music turns over.
          </p>
        </div>

        <div>
          <button type="submit" className={step.primary}>
            Time the video to this song
          </button>
        </div>
      </form>

      {/*
        Closed by default and deliberately quiet: this is reassurance for the
        person who is worrying about the day, not a task on this screen. There
        is no new machinery behind it — a practice run is a person, a phone and
        the video, which is exactly what will happen in the room.
      */}
      <details className={styles.practice}>
        <summary className={styles.practiceSummary}>How to have a practice run</summary>
        <ol className={styles.practiceBody}>
          <li>
            Open the video on a laptop and have the song ready on a phone, paused at the very start.
          </li>
          <li>
            Start the video. Press play on the song when the screen fades up from black — that is
            the cue, and it is something you can see from the back of a room.
          </li>
          <li>
            If the song ends first, it simply ends; if the video ends first, the last picture holds.
            Being a few seconds out is normal and nobody will notice.
          </li>
        </ol>
        <p className={styles.hint}>
          Once the video is made, the{' '}
          <Link className={step.quiet} href={`/m/${memorialId}/deliver/timing-card`}>
            timing card for the venue
          </Link>{' '}
          prints these same words for whoever is playing the song on the day.
        </p>
      </details>
    </StepScreen>
  );
}
