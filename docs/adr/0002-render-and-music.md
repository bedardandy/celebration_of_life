# ADR 0002 — Rendering, and where the music comes from

- **Status:** accepted
- **Date:** 2026-07-28
- **Applies to:** Phase 5 (music, render worker, delivery) and everything after

## Context

Phase 5 turns a slideshow into a file a funeral director can play. Three
decisions in it are load-bearing enough to write down, because each one has an
obvious alternative that would have been worse in a way that only shows up
later — in a chapel, in front of a room.

## Decisions

### 1. The bundled music library is synthesised, not sourced

Commercial recordings cannot be baked into a video a family then shares: that is
a per-song synchronisation licence, negotiated per use. The usual answer is to
assemble a library of Creative Commons tracks from the internet — but a
provenance chain that rests on somebody's upload page is exactly the thing we
tell families we will not ship, and we cannot verify it on their behalf.

So `scripts/make-music.ts` **computes** eight instrumental pieces: a wavetable
additive synthesiser with ADSR envelopes and per-partial decay, four voices over
a slow diatonic progression, through a Schroeder reverb, at tempi we chose. The
output is dedicated to the public domain (CC0) and each track's `LICENSE.txt`
records the key, tempo and seed, along with the fact that re-running the script
reproduces the file byte for byte.

Consequences, stated plainly:

- The provenance question has a complete answer that fits in a paragraph, and
  the answer is a file in this repository rather than a claim about a website.
- The music is placeholder-but-shippable: quiet and unobtrusive rather than
  beautiful. Replacing a track with a real composer's cleared work means
  dropping in an `audio.m4a` and a `meta.json`; nothing else changes.
- Because the tempo was _chosen_, every beat grid is exact arithmetic
  (`beatGridFromBpm`) rather than a detector's estimate. Tempo detection
  (`music-tempo`) exists only for audio a family uploads themselves.
- The encoded audio (~18 MB for eight tracks, each under 3 MB) is committed.
  Generating it takes five and a half minutes of CPU, and a family's first
  render must not wait on that.

### 2. Photographs reach the renderer over loopback HTTP, not as data URIs

Remotion drives a headless Chromium, which will not open `file://` URLs from a
page served over http — correctly. That leaves two ways to get sixty to eighty
2400px photographs into the render.

The micro-render test inlines them as `data:` URIs, which is right for one
fixture photograph and wrong here: base64 inflates each file by a third, and the
whole set has to be serialised into the composition's input props, parsed by the
browser, and held in memory for the entire render. At sixty photographs that is
tens of megabytes of props before a frame is drawn.

Instead, `startAssetServer` (in `@col/video`) opens an HTTP server on
`127.0.0.1:0` for the life of one render, serving exactly the files that render
needs from a scratch directory. The browser streams and evicts images as it
goes, so memory is flat whether there are six photographs or six hundred.

- The route is `/a/<assetId>` against an allowlist built from the render's own
  asset map, so there is no path in a URL and no traversal to defend against.
- The socket is bound to loopback with a kernel-assigned port and is closed in a
  `finally`.
- The alternative of a bundler `publicDir` was rejected because it would copy
  every photograph into the bundle and invalidate the cached bundle per job.

### 3. A render is not "done" until ffprobe agrees

"It wouldn't play at the funeral" is this product's catastrophic failure, and it
is almost never visible in a preview: it is a full-range pixel format, a missing
audio track, an index at the wrong end of the file. So the render handler
verifies its own output before recording success — H.264, yuv420p, an AAC track,
MP4, `moov` before `mdat` (read from the bytes, not inferred from a log), and a
duration within half a second of the timeline. A mismatch fails the job, which
retries; it never reaches a family.

Two smaller decisions follow from the same instinct:

- The side-loaded mode muxes a **real silent AAC track** rather than shipping a
  file with no audio stream, because some venue players refuse to open or seek
  one that has none.
- Loudness normalisation is two-pass with `linear=true`. One pass would ride a
  compressor over quiet, dynamic material and make a tribute sound pumped.

## Consequences

- `apps/worker` depends on `@col/video`, and `@remotion/bundler` /
  `@remotion/renderer` moved from dev to runtime dependencies of `@col/video`.
  The heavy imports are dynamic and `@col/video/render` is a separate export
  path, so the web app's bundle is unaffected.
- The Remotion bundle is cached per entry point for the life of the worker
  process; the cache stores the promise, so two renders starting together wait
  on one build.
- Rendering is CPU-bound software rasterisation (`gl: 'swangle'`), chosen for
  determinism across machines. It is slower than a GPU path and it is the same
  everywhere, which is what makes "the preview is the file" true.

## Measured, on four 2.1 GHz cores with no GPU

| preset                | frames/second | a 5-minute service cut |
| --------------------- | ------------- | ---------------------- |
| draft360 (640×360)    | 9.8           | ~15 min                |
| backup720 (1280×720)  | 4.0           | ~37 min                |
| final1080 (1920×1080) | 2.0           | ~75 min                |

Concurrency made no difference (2.07 fps at four workers against 2.06 at the
default) and neither did the portrait blur (landscape photographs rendered at
the same 2.05 fps), so the cost is raster and encode throughput rather than
anything the composition is doing. A developer laptop is several times faster.

The consequence for the product is a copy decision rather than a code one: the
deliver screen states "usually about 5–15 minutes" only as a typical case, and
switches to an extrapolation from the render's own measured progress as soon as
it is a tenth of the way through. See `describeRenderProgress`.
