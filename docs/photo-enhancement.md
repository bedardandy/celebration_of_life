# Gently improving a photograph

A phone photograph of a print on a kitchen table is flat, a bit yellow, slightly soft and
sometimes speckled. Every one of those has a conservative fix. This is what we do, what we refuse
to do, and how to drop in a heavier restorer if you decide you want one.

**The rule that outranks everything else: the person must still look like themselves.** Families
are extremely sensitive to a face that is subtly not their mother's, and this runs on the last
photograph anybody has of someone. A restorer that invents a plausible face is worse than no
restorer, because nobody can tell it happened.

---

## What the family sees

1. In a photograph's own "More" menu on the curation screen: **Improve this photo**. Nothing is
   automatic, nothing is batched, and nothing happens to a photograph nobody asked about.
2. The worker makes an `enhanced2400` variant. The original bytes and the plain `render2400`
   variant are untouched.
3. The menu then shows a **before and after, side by side**, with two buttons — _Use the improved
   version_ / _Keep the original_ — and the sentence _"The original is always kept. You can change
   your mind at any time."_ No slider, no drag: a button-based comparison works with a trackpad, a
   trembling hand, or no JavaScript at all.
4. Until somebody chooses, **the original is what every screen and every render serves**. Choosing
   the improved copy flips the variant the EDL asks for; choosing the original flips it back. The
   enhanced file is never deleted — changing your mind twice is ordinary.
5. A chosen photograph carries a quiet badge: **Gently restored**.

---

## What the built-in restorer does

`packages/media/src/enhance/sharp-restorer.ts`. Everything is decided from measurements, and every
step is skipped when the numbers say it is not needed:

| Step        | When                                                       | What                                                  |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| **Levels**  | luminance range below 92% of full                          | Partial histogram stretch, capped at **1.8×** slope   |
| **Colour**  | mean saturation below 0.25                                 | `modulate({ saturation })`, capped at **1.2×**        |
| **Denoise** | detail survives a median filter poorly (<0.45) and is high | 3×3 median                                            |
| **Sharpen** | detail below a crisp threshold                             | `sharpen({ sigma: 0.6–0.9 })`, gentler after a median |

And what it never does:

- never changes geometry — no crop, no resize, no rotation, no upscaling;
- never touches faces structurally;
- never runs at all without somebody pressing the button.

The before/after sentence is generated from the measured difference
(`describeEnhancement`), so it cannot claim something that did not happen: a photograph that was
already fine gets _"This one was already in good shape, so almost nothing changed."_

Sizing: the copy is made at the same longest edge as `render2400` (2400px) and is never enlarged
past the original's own size.

---

## Dropping in Real-ESRGAN or CodeFormer

The `Restorer` interface is three members wide — `id`, `available()`, `restore(buffer) → { data,
width, height, before, after, steps, summary }` — and the external adapter already implements it
by shelling out:

```
RESTORER_CMD="realesrgan-ncnn-vulkan -i {in} -o {out}"
RESTORER_TIMEOUT_MS=300000
```

- `{in}` and `{out}` are substituted with **PNG** paths in a scratch directory.
- **No shell is involved.** The command is split on whitespace (quoted segments kept whole) and
  executed directly, so nothing in a filename can become a shell command.
- Whatever comes back is **scaled to the original dimensions**. Face restorers routinely return a
  4× upscale; a slideshow whose photographs silently changed shape no longer matches its preview.
- A missing binary, a non-zero exit or a timeout is reported honestly; the photograph is recorded
  as "we could not improve this one, and nothing about it has changed."

When `RESTORER_CMD` is set it replaces the sharp restorer entirely. Set it on the **worker**; the
web app never runs one.

### The fidelity warning, which matters more than any of the above

Real-ESRGAN and CodeFormer do not sharpen a photograph. They **generate** a plausible one.

On a landscape or a building that is a gift. On a 1962 wedding photograph where the bride's face
is forty pixels across, the model has to invent eyes, a mouth and a jawline, and what it invents
comes from its training data — not from the woman. The result is often _strikingly clear_ and
subtly **not her**. A family will notice something is wrong without being able to say what, and
they will notice at the worst possible moment, on a screen, at a funeral.

So if you enable one:

- **CodeFormer's fidelity weight `w` is the whole game.** `w=0` gives maximum "quality" — the
  model's face. `w=1` stays closest to the input. **`w≈0.7` is the setting to start from** for
  memorial work: enough restoration to help, weighted firmly toward the actual person. Do not ship
  the default.

  ```
  RESTORER_CMD="python /opt/CodeFormer/inference_codeformer.py -w 0.7 --input_path {in} --output_path {out}"
  ```

- **Prefer Real-ESRGAN without face enhancement** (`-n realesrgan-x4plus`, no `--face_enhance`) if
  what you actually need is a bigger, cleaner scan. It touches texture, not identity.
- **Show the before and after, always.** It is already built; do not "improve" behind anyone's
  back.
- Consider saying so in the copy on your deployment: a family should be told that a computer
  filled in detail, not left to wonder.

The built-in sharp restorer is the default precisely because it cannot do any of this. It moves
levels, colour and edges. It cannot change who is in the photograph.

---

## Where things are

| Path                                              | What                                               |
| ------------------------------------------------- | -------------------------------------------------- |
| `packages/media/src/enhance/restorer.ts`          | The interface and the before/after wording         |
| `packages/media/src/enhance/sharp-restorer.ts`    | Measuring, planning, and the built-in pipeline     |
| `packages/media/src/enhance/external-restorer.ts` | The `RESTORER_CMD` adapter                         |
| `apps/worker/src/handlers/enhance-asset.ts`       | The job: one new variant, nothing else touched     |
| `packages/core/src/curate/enhance.ts`             | Accept / revert, and which variant anything serves |
