# The printed program

The program is the one thing from the day that people keep. It goes in a Bible,
in a drawer, inside the back of a photo album, and it comes out again years
later. This is how ours is produced, and what to tell a printer.

## What the app makes

`/m/{memorialId}/program` walks five decisions, one per screen:

| Screen    | What it settles                                                    |
| --------- | ------------------------------------------------------------------ |
| `cover`   | The portrait, chosen from photographs the family already approved  |
| `order`   | The order of service, prefilled from the family's tradition pack   |
| `sketch`  | 150–250 words about their life (AI may draft it; the family edits) |
| `reading` | A reading or verse — a pack suggestion, or the family's own        |
| `thanks`  | The acknowledgement, already written out, for the back page        |

`/m/{memorialId}/program/print` renders the result as **four pages in reading
order**, each one labelled on screen (`Page 1 — the front cover`) and each one
breaking onto its own sheet when printed. `?paper=letter` sets it for US Letter;
the default is A4.

`/api/program/{memorialId}/program.txt` is the same document as plain text, for
the funeral homes that set the program themselves and want the words in an
email. It is organiser-session gated, like every other private route here.

## Imposition is the print shop's job

We deliberately do **not** impose the pages — that is, we do not print page 4 and
page 1 side by side on one sheet and pages 2 and 3 on the other. Getting
imposition right depends on the paper, the fold, the printer's duplex behaviour
and the trim, and getting it wrong produces a booklet that reads back to front.
Every print shop does this every day.

What to ask for, in their words:

> A half-fold (bi-fold) four-page booklet on one sheet, printed both sides.
> Pages are supplied in reading order: 1, 2, 3, 4.

At home, printing the four pages and folding a stack of A4 in half works fine and
plenty of families do exactly that. If you print double-sided at home, print
pages 1 and 2 on one sheet and 3 and 4 on another, then fold — or simply staple
the four sheets in order.

Paper worth asking for: 120–170 gsm, matt rather than gloss (gloss is hard to
read under fluorescent lighting and shows fingerprints). Order more copies than
you think you need. Families almost always run out, and a print shop's second run
costs more than the first.

## Readings and copyright

Tradition packs carry a `readings` list. Anything with a `text` field is
reproduced in the program, and every one of those carries a provenance line in
its `source` saying why we may: a public-domain translation, a traditional
liturgical text, or a plain English rendering written for this project. A
reading that is still in copyright — a modern poem, a gospel lyric — is **named
and sourced only**, never reproduced, and the app says so on screen.

If a family pastes in their own reading, we take it as given and say plainly, on
that screen, that printing a modern poem or a song lyric in full may need
permission, and that naming it with the author always works.

## Adding a reading to a tradition pack

`packages/tradition-packs/data/<slug>.json`:

```jsonc
"readings": [
  {
    "title": "Psalm 23 — The Lord is my shepherd",
    "source": "Psalm 23, King James Version, 1611 — public domain",
    "text": "The Lord is my shepherd; I shall not want. …"
  }
]
```

The loader test enforces two things: every pack has at least one reading and one
order-of-service item, and any reading carrying `text` states its provenance. Add
a text without a provenance line and the test fails, which is the point.
