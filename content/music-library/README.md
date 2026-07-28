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

## Layout

One directory per track, named by slug:

```
content/music-library/
  README.md
  <track-slug>/
    audio.m4a        AAC-LC, 48 kHz stereo, ~192 kbps (the render mux source)
    audio.mp3        optional — browser preview fallback
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

Grids are generated offline (`music-tempo` plus a manual check against the
waveform) and committed. They are data, not something to recompute per render.

## Licence provenance

Every track needs, in `meta.json` and in `LICENSE.txt`:

- the exact licence (CC0, CC-BY, a named royalty-free licence, or public domain
  by age — with the reasoning),
- where we obtained it and when,
- who verified it,
- any attribution the licence requires — attribution text is surfaced in the
  delivery page and in the printed director card, not buried here.

If a licence needs a lawyer to interpret, the track does not ship. There will be
at least eight tracks by Phase 5, chosen for range (gentle piano, strings, warm
guitar, hymn-adjacent, upbeat) rather than for quantity.
