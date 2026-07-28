# Bundled music library

Commercial songs cannot be baked into a video that a family then shares: that is
a per-song synchronisation licence, negotiated per use, and it is not something
we can do on their behalf. So the product offers two honest modes:

1. **Cleared audio, baked in** — a track from _this_ library is mixed into the
   MP4. The file plays anywhere, can be emailed, and can sit on the funeral
   home's website.
2. **Silent and side-loaded** — the video is rendered silent but timed to the
   family's chosen song, and the venue plays that song live from their own copy.
   Nothing is embedded, so nothing is licensed.

Everything in this directory belongs to mode 1. If we cannot prove a track is
clear, it does not go in here.

## What is actually here (Phase 5)

Eight original instrumental pieces, **synthesised by
[`scripts/make-music.ts`](../../scripts/make-music.ts)** and dedicated to the
public domain under CC0 1.0.

This is the honest answer to a hard constraint: we cannot download somebody
else's recordings, and a library whose provenance rests on a stranger's upload
is exactly the thing this file says we will not ship. So the music is computed —
a small additive synthesiser (wavetable oscillators, ADSR envelopes, per-partial
decay), four voices over a slow diatonic progression, through a Schroeder
reverb, at a tempo we chose. No performer, no sample library, no third-party
recording, nothing for anyone to claim a fee on. `LICENSE.txt` in each directory
records the key, tempo, seed and the fact that re-running the script reproduces
the file byte for byte.

They are placeholder-but-shippable: quiet, unobtrusive, and good enough that a
room will not notice them, which is the job. Replacing any of them with a real
composer's cleared work is a matter of dropping in an `audio.m4a` and a
`meta.json`; nothing else in the product knows the difference.

| slug              | title           | key          | BPM | length |
| ----------------- | --------------- | ------------ | --- | ------ |
| `morning-light`   | Morning Light   | F major      | 72  | 2:45   |
| `gentle-river`    | Gentle River    | D minor      | 64  | 3:05   |
| `evensong`        | Evensong        | B-flat major | 60  | 3:17   |
| `quiet-hours`     | Quiet Hours     | A minor      | 63  | 3:08   |
| `the-long-meadow` | The Long Meadow | G major      | 76  | 3:27   |
| `harbour-light`   | Harbour Light   | C major      | 69  | 2:52   |
| `after-the-rain`  | After the Rain  | E minor      | 70  | 2:50   |
| `all-the-years`   | All the Years   | D major      | 74  | 3:33   |

### The audio is committed, deliberately

Each `audio.m4a` is AAC-LC at 96 kbps and 1.9–2.5 MB — under the 3 MB per-track
line, about 18 MB for the set. Generating them takes five and a half minutes of
CPU, and a family's first render must not wait on that, so the files live in the
repository and `pnpm music:build` is only needed when the music itself changes.

    pnpm music:build    regenerate every track from the script (deterministic)
    pnpm music:seed     load content/music-library into music_tracks

Seeding is idempotent and also runs at worker boot, keyed on `slug`, so a track
a family already chose keeps its row id.

## Layout

One directory per track, named by slug:

```
content/music-library/
  README.md
  <track-slug>/
    audio.m4a        AAC-LC, 44.1 kHz stereo, 96 kbps (preview and render source)
    meta.json        licence provenance + beat grid
    LICENSE.txt      the licence text as published, copied verbatim
```

Slugs are lowercase kebab-case and never change once shipped: `music_tracks.slug`
in the database points at them, and so does every EDL that used the track.

## meta.json

```jsonc
{
  "slug": "morning-light",
  "title": "Morning Light",
  "artist": "A. Composer",
  "durationSec": 214.6,

  // public-domain | royalty-free   (family-supplied never lives in this dir)
  "licenseKind": "public-domain",
  "licenseNote": "Recording released under CC0 1.0 by the performer.",
  "sourceUrl": "https://example.org/where-we-got-it",
  "acquiredAt": "2026-02-11",
  // Who checked, and what they checked. A name here is the point.
  "verifiedBy": "andy",

  "moodTags": ["gentle", "hopeful", "piano"],
  // Traditions this track suits. Empty array = no restriction.
  "traditionTags": [],

  // Precomputed at library build time so the timing engine never does DSP at
  // request time. Seconds from the start of the track.
  "beatGrid": {
    "bpm": 72.0,
    "beats": [0.42, 1.25, 2.08],
    "phrases": [0.42, 13.75, 27.08],
  },
}
```

`beatGrid` matches `BeatGridSchema` in `@col/schemas`; the whole file is
validated when the library is loaded, and a track that fails validation is
excluded rather than shipped half-known.

## Beat grids

`phrases` matters more than `beats`. Cutting a slideshow on every beat looks
frantic; cutting on phrase boundaries (usually every 8 or 16 beats) is what makes
a tribute feel composed rather than assembled. The timing engine snaps
transitions to the nearest phrase boundary inside the 3–7 s per-photo band.

Grids are computed from the tempo the track was _synthesised at_, so they are
exact rather than estimated: `beatGridFromBpm(bpm, durationSec)` in `@col/media`,
with a phrase every eight beats. `music-tempo` detection is used only for audio a
family uploads themselves, where there is no known tempo to start from — and for
a song we never receive (side-loaded mode) the family taps the tempo instead.

## Licence provenance

Every track needs, in `meta.json` and in `LICENSE.txt`:

- the exact licence (CC0, CC-BY, a named royalty-free licence, or public domain
  by age — with the reasoning),
- where we obtained it and when,
- who verified it,
- any attribution the licence requires — attribution text is surfaced in the
  delivery page and in the printed director card, not buried here.

If a licence needs a lawyer to interpret, the track does not ship.

For the generated set, all four points collapse into one answer: the licence is
CC0, the source is `scripts/make-music.ts` in this repository, the verification
is that the script produces the file, and no attribution is required.
