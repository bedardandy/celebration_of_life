'use client';

/**
 * Half a minute of each candidate, so nobody has to guess.
 *
 * There are nine recordings of Danny Boy and the family means one of them. This
 * is a search box, a short list, and a Listen button — a way of *recognising* a
 * song, not a way of getting one. What it leaves behind is two strings typed
 * into the fields below it; the preview itself is never downloaded, never mixed
 * into the video, and never synced to anything.
 *
 * Nothing plays unless a person presses a button, and one shared `<audio>`
 * element means a second Listen silences the first rather than layering on top
 * of it. The rules are in `audition-state.ts`, tested without a browser.
 *
 * When the catalogue cannot be reached, this shrinks to a sentence. The fields
 * underneath were always the way through and they still are.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  auditionReducer,
  applyAuditionChoice,
  currentPreviewUrl,
  formatTrackLength,
  initialAuditionState,
} from './audition-state';
import type { AuditionTrack } from '@col/core/music-audition';
import styles from './music.module.css';

export type SongAuditionProps = {
  /** Ids of the fields "This is the one" writes into. */
  titleFieldId: string;
  artistFieldId: string;
};

export function SongAudition({ titleFieldId, artistFieldId }: SongAuditionProps) {
  const [term, setTerm] = useState('');
  const [state, dispatch] = useReducer(auditionReducer, initialAuditionState);
  const [chosen, setChosen] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  // Leaving the screen must not leave a song playing behind it.
  useEffect(() => {
    const element = audio.current;
    return () => element?.pause();
  }, []);

  const playing = currentPreviewUrl(state);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (!playing) {
      element.pause();
      return;
    }
    if (element.src !== playing) element.src = playing;
    element.currentTime = 0;
    void element.play().catch(() => dispatch({ type: 'audio-problem' }));
  }, [playing]);

  const search = useCallback(async () => {
    const query = term.trim();
    if (query.length === 0) return;
    dispatch({ type: 'search-started' });
    try {
      const response = await fetch(`/api/music/search?q=${encodeURIComponent(query)}`);
      const body = (await response.json()) as { tracks?: AuditionTrack[]; unavailable?: boolean };
      if (!response.ok || body.unavailable || !Array.isArray(body.tracks)) {
        dispatch({ type: 'search-unavailable' });
        return;
      }
      dispatch({ type: 'search-answered', tracks: body.tracks });
    } catch {
      dispatch({ type: 'search-unavailable' });
    }
  }, [term]);

  const choose = (track: AuditionTrack) => {
    const byId = (id: string) => {
      const element = document.getElementById(id);
      return element instanceof HTMLInputElement ? element : null;
    };
    applyAuditionChoice(track, { title: byId(titleFieldId), artist: byId(artistFieldId) });
    setChosen(track.id);
    dispatch({ type: 'pause' });
  };

  return (
    <section className={styles.audition}>
      <div className={styles.auditionSearch}>
        <label className={styles.label} htmlFor="songSearch">
          Search for the song
        </label>
        <div className={styles.auditionRow}>
          <input
            id="songSearch"
            type="search"
            className={styles.input}
            value={term}
            maxLength={120}
            placeholder="danny boy"
            autoComplete="off"
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              // Enter here must not submit the form underneath.
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
          <button
            type="button"
            className={styles.preview}
            onClick={() => void search()}
            disabled={state.status === 'searching' || term.trim().length === 0}
          >
            {state.status === 'searching' ? 'Looking…' : 'Search'}
          </button>
        </div>
      </div>

      {state.status === 'unavailable' ? (
        <p className={styles.hint} aria-live="polite">
          We could not reach the song catalogue just now — typing the name works just as well.
        </p>
      ) : null}

      {state.status === 'nothing' ? (
        <p className={styles.hint} aria-live="polite">
          Nothing came back for that. A different spelling often finds it, and typing the name below
          works just as well.
        </p>
      ) : null}

      {state.tracks.length > 0 ? (
        <>
          <ul className={styles.auditionResults}>
            {state.tracks.map((track) => {
              const isPlaying = state.playingId === track.id;
              const length = formatTrackLength(track.durationMs);
              return (
                <li key={track.id} className={styles.auditionTrack}>
                  {track.artworkUrl100 ? (
                    <img
                      className={styles.auditionArt}
                      src={track.artworkUrl100}
                      alt=""
                      width={56}
                      height={56}
                      loading="lazy"
                    />
                  ) : (
                    <span className={styles.auditionArt} aria-hidden="true" />
                  )}

                  <div className={styles.auditionBody}>
                    <p className={styles.auditionTitle}>{track.trackName}</p>
                    <p className={styles.trackMeta}>
                      {track.artistName}
                      {track.collectionName ? ` · ${track.collectionName}` : ''}
                      {length ? ` · ${length}` : ''}
                      {track.explicit ? ' · explicit lyrics' : ''}
                    </p>
                    {chosen === track.id ? (
                      <p className={styles.trackWhy}>Filled in below. You can still change it.</p>
                    ) : null}
                  </div>

                  <div className={styles.trackActions}>
                    <button
                      type="button"
                      className={styles.preview}
                      onClick={() => dispatch({ type: 'play', id: track.id })}
                      aria-label={
                        isPlaying
                          ? `Pause ${track.trackName}`
                          : `Listen to half a minute of ${track.trackName} by ${track.artistName}`
                      }
                    >
                      {isPlaying ? 'Pause' : 'Listen · 30s'}
                    </button>
                    <button type="button" className={styles.choose} onClick={() => choose(track)}>
                      This is the one
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className={styles.hint}>
            This half-minute preview is only to check you have the right version. On the day the
            song is played out loud in the room — the video itself stays silent, which is what lets
            you share it afterwards.
          </p>
        </>
      ) : null}

      <audio
        ref={audio}
        preload="none"
        onEnded={() => dispatch({ type: 'ended' })}
        onError={() => dispatch({ type: 'audio-problem' })}
      />
    </section>
  );
}
