# How this product talks

Everything a person reads here is read by someone who has recently lost somebody. Most of them
are between 55 and 80. Many are on a phone, at a kitchen table, at eleven at night, three days
before a funeral. Grief measurably impairs memory, attention and decision-making — that is not a
metaphor, it is the reason for every rule below.

These rules are not style preferences. They are the interface.

---

## The seven rules

### 1. Plain words, short sentences

Aim at about a sixth-grade reading level. One clause where two would do. No word a person would
have to look up, and no word that only makes sense if you already know how the product works.

| Instead of                            | Write                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| Quick preview render (small and fast) | Make a quick, small copy to check first                               |
| Initiating the render pipeline        | Making the video now                                                  |
| Asset ingestion failed                | Nothing arrived that time. Choosing the photos again usually does it. |
| Authentication token expired          | That link has expired. We can send you a new one.                     |

Product nouns are for us, not for them: **render, EDL, asset, ingest, token, session, blob,
preset, transcode** never appear on screen. The words on screen are _video, photo, link, page_.

### 2. Never alarm

No red. No exclamation marks. No "Error", "Warning", "Failed", "Invalid", "Denied". Nothing that
reads as though the person has broken something or lost something.

| Instead of                               | Write                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Error: render failed                     | Something went wrong making the video. Starting it again usually works, and we keep the details.            |
| Invalid email address                    | Please check the email address.                                                                             |
| Access denied                            | We could not find that link. It may have been copied incompletely.                                          |
| Your link is invalid or has been revoked | This link is no longer active. Please check with the family. Anything you already shared is safe with them. |

When something does go wrong, the sentence has three parts and no blame: **what happened, what it
means for their things, what to do next.** The third part is often "nothing".

### 3. Never blame the person

The passive voice is normally bad writing and is occasionally the kind thing to do. "Nothing
arrived that time" is better than "You did not select any files."

A closed contributor link is the sharpest example: somebody was _asked_ to help, they tapped the
link a week later, and it did not open. The worst reading of that moment is "you did something
wrong". So: what happened, who to ask, and an explicit sentence that nothing they already sent has
been lost.

### 4. Say what is true, including about time

Never state a number the code did not measure. A render says "about 5–15 minutes" until its own
progress justifies an estimate, and only then says "about four more minutes".

| Instead of                     | Write                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| Estimated time remaining: 4:32 | About 4 more minutes. You can close this page — we will keep working. |
| Processing…                    | In the queue. It will start in a moment — you can close this page.    |
| Upload complete                | 3 added. Thank you.                                                   |

If the honest answer is "we do not know yet", say the vaguer sentence.

### 5. One decision per screen, one primary action

If a screen needs two primary buttons, it is two screens. Everything else is a quiet underlined
link: _Skip this question_, _I'm done for now_, _Not now_, _Back to the dashboard_. Stopping must
never read as giving up.

Skipping is a first-class answer and is worded like one. Not "Skip (you can do this later)" —
just "Skip this question".

### 6. Reassure about permanence, every time it is relevant

There are no Save buttons. That means the copy has to carry the reassurance instead, and it has to
be everywhere the thought could occur:

- "Everything here saves itself. You can close this and come back whenever you like."
- "You can close this page: we keep working, and the files will be here when you come back."
- "This link keeps working."
- "Anything you already shared is safe with them."
- "Nothing here is published anywhere. You decide what stays in."

### 7. Nothing sells, nothing celebrates, nothing performs sympathy

No upsell, no badges, no streaks, no progress gamification, no confetti, and no "Sorry for your
loss" — a stranger's condolences from a piece of software are worse than none. Warmth comes from
being useful and from getting the person's name right.

"Thank you." is the whole heading on the contributor's last screen. That is the register.

---

## Specific words

| Use                          | Not                                                       |
| ---------------------------- | --------------------------------------------------------- |
| the video                    | the render, the output, the deliverable                   |
| photo, photograph            | asset, media, image file                                  |
| link                         | URL, token, capability, magic link (in front of a person) |
| the family                   | the organizer, the account holder, the user               |
| turn this link off           | revoke, disable, deactivate                               |
| we could not find that link  | 404, not found, invalid                                   |
| a quick, small copy to check | draft360                                                  |
| the video for the service    | final1080                                                 |
| about five minutes           | 4m 58s, 298s                                              |

Names: use the person's name as the family typed it, and the short name they were actually called
(`decedentKnownAs`) wherever a sentence would otherwise sound like a form. "Tell me about Ruth",
not "Tell me about the decedent".

---

## Accessibility, which is the same subject

An eighty-year-old on a phone and a screen-reader user want most of the same things.

- **Every interactive thing has a name that says what it does.** A photograph's button in the
  curation grid is labelled "Keep Ruth at the beach", not with the filename it happens to carry.
- **Focus is always visible.** A three-pixel outline in the focus colour, including on `<summary>`
  and anything with a `tabindex` — browsers do not outline those by default.
- **Touch targets are at least 48px.** `--tap` in `globals.css`; there are no exceptions.
- **Text that only a screen reader needs uses `.visually-hidden`.** The interview question is the
  page heading, so the answer box is labelled with it invisibly rather than showing it twice.
- **Anything that changes without a page load is announced.** `SavedIndicator` and the render
  progress line are `role="status"` with `aria-live="polite"` — the person waiting on a video may
  not be looking at the screen.
- **Nothing moves on its own,** and `prefers-reduced-motion` removes what little does. This reaches
  the page chrome around the slideshow — the progress bar, the fades on the venue screen. It does
  not reach the slideshow itself: the composition moves by computing a transform per frame, not
  with CSS animation, so the preview stays frame-identical to the file.
- **Nothing auto-plays. Ever.** Not the preview, not the watch page, not the venue screen. A
  tribute video that starts by itself while somebody is reading is the single unkindest thing this
  product could do.

---

## Reviewing copy

Read it out loud, in the voice of somebody who is tired and has been crying. If any sentence makes
them feel stupid, watched, hurried, or at fault, it is wrong — however accurate it is.
