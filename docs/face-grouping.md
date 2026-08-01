# Finding the same face across the decades

"Where are the photographs of Ruth?" is the question a curation screen full of four hundred photos
cannot answer, and the one every family asks. Face grouping answers it — and it is the most
easily-misread feature in this product, so it is built with more restraint than anything else here.

**The promise, which is not negotiable: nothing leaves the machine.** There is no third-party face
API in this codebase and there never will be. A family handing over a shoebox of photographs has
not agreed to a biometric record of everyone who ever stood next to their mother.

**It is off unless an operator turns it on.** With `FACE_ENGINE` unset there is no card, no
button, no strip of suggestions and no mention of it anywhere in the interface.

---

## How it behaves for a family

1. On the curation screen, one card: _"Find the same faces across your photos. This happens
   entirely on this computer and is deleted with the memorial."_ One button. Nothing runs on
   upload, nothing runs on a schedule.
2. The worker looks through the photographs and groups the faces.
3. Groups come back as **suggestions**, hedged: _"These look like the same person — 14 photos"_,
   with a box to name them and a "Not the same person" button beside it.
4. A named group becomes a filter chip — **Ruth · 34 photos** — and the coverage nudge becomes
   specific: _"No photos of Ruth from their thirties yet — someone may have a shoebox. Ask them?"_
5. Deleting the memorial deletes every face row with it, by foreign key.

Nothing is ever applied automatically. A group is a suggestion until a person confirms it.

---

## Turning it on

### The engine

```
FACE_ENGINE=onnx          # off (default) | mock | onnx
FACE_MODEL_DIR=/var/lib/celebration/models
```

`mock` is a deterministic engine with no model in it: embeddings are derived from the filename. It
exists for tests and for looking at the screens in development. **Never set it in production** —
it produces confident, meaningless groups.

### The runtime

```
pnpm add -O onnxruntime-node --filter @col/media
```

It is an _optional_ dependency: not installed is a supported state, and the engine reports
`available: false` with a sentence rather than crashing. On Linux x64, macOS arm64 and Windows x64
the package ships its own prebuilt native binding, so no compiler is involved. If your package
manager blocks install scripts (pnpm does by default) that is fine — the ignored script only
fetches optional CUDA providers.

### The models

Two files, both from InsightFace's released packs, both permissively licensed for non-commercial
research use — **check the licence against your own use before deploying commercially**:

| Role     | File             | Pack        | Size   | Notes                                 |
| -------- | ---------------- | ----------- | ------ | ------------------------------------- |
| Detector | `det_500m.onnx`  | `buffalo_s` | ~2 MB  | SCRFD 500M — finds faces, gives boxes |
| Embedder | `w600k_mbf.onnx` | `buffalo_s` | ~13 MB | MobileFaceNet ArcFace — 512-d vectors |

Download the pack **on a machine with a network**, not on the server if the server is offline:

```bash
# https://github.com/deepinsight/insightface/tree/master/model_zoo
curl -LO https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip
unzip buffalo_s.zip -d /var/lib/celebration/models
ls /var/lib/celebration/models   # det_500m.onnx  w600k_mbf.onnx
```

The larger `buffalo_l` pack (`det_10g.onnx` + `w600k_r50.onnx`, ~275 MB) is more accurate and
several times slower. If you use it, point the filenames at it:

```
FACE_DETECTOR_MODEL=det_10g.onnx
FACE_EMBEDDER_MODEL=w600k_r50.onnx
```

Nothing in this product ever downloads a model. If the files are not in `FACE_MODEL_DIR`, the
engine says so in the worker log at boot and the feature stays invisible:

```
face grouping is configured but unavailable — Face model file not found: /var/lib/…/det_500m.onnx
```

Restart the worker after installing them; the probe runs once at boot.

---

## How the grouping works

`packages/media/src/faces/`:

| File         | What it is                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- |
| `types.ts`   | The `FaceEngine` interface: `available()` and `detect(image) → [{box, embedding, quality}]` |
| `cluster.ts` | Pure arithmetic: cosine similarity, greedy assignment, a merge pass. No model.              |
| `scrfd.ts`   | The index arithmetic that turns detector tensors into rectangles. No model.                 |
| `mock.ts`    | The deterministic engine used by every test in this repo.                                   |
| `onnx.ts`    | Session loading, preprocessing, and the two `run()` calls.                                  |

`cluster.ts` and `scrfd.ts` are unit-tested with hand-written vectors and tensors, on a machine
with no models installed, because those are the parts that go quietly wrong: a misdecoded box
lands in a plausible-looking wrong place, and a mis-tuned threshold puts a stranger in "photos of
Ruth".

### The threshold

`DEFAULT_CLUSTER_THRESHOLD = 0.62` — cosine similarity above which two faces are called the same
person. It suits ArcFace-style embeddings, which run around 0.3 between strangers and around 0.7
between two photographs of one person.

It errs **high** on purpose. The two failure modes are not symmetric:

- too high → one person is split into two groups → the organiser types a name twice;
- too low → two people merge → a stranger appears in "photos of Ruth", and the family stops
  trusting the feature entirely.

If you change embedder, re-tune it. That is an operator's job, not a family's.

---

## Privacy, concretely

- `face_detections` rows hold a box, a 512-float vector, a quality score and the engine's name.
  There is no image data and no name until somebody types one.
- Every row carries `memorialId` with `ON DELETE CASCADE` — even though the asset already implies
  it — so a purge cannot miss them by forgetting a join. There is a test for exactly this.
- No blobs are created by face grouping, so there is nothing extra for a blob purge to reach.
- Naming a group writes a `people` row, the same table the story and the printed program use.
  Names are the only durable thing here, and they belong to the family.
- "Not the same person" writes `dismissedAt` and the group is never suggested again, including
  after re-running.

---

## What it costs

The small pack on a modern four-core CPU runs roughly 5–15 photographs a second at 1600px, so a
four-hundred-photograph memorial is under two minutes. `buffalo_l` is perhaps four times slower
and worth it only if the small pack is visibly splitting people. Detection is done on the
`web1600` variant, which is already upright and already on disk.
