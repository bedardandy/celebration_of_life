# Bringing photos over from Google Photos

Half a family's photographs live in Google Photos, and an organiser three days from a funeral is
not going to download four hundred files to a laptop and upload them again. This is how that
import works, what an operator has to do to turn it on, and the one tradeoff worth knowing about.

**It is off until you configure it.** With `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` unset, the card never renders on the collect screen, both routes
answer 404, and nobody is told about a feature they cannot have. That is deliberate: a
half-configured integration that fails at Google's end is worse than one that is simply not
offered.

---

## Why the Picker API

Google closed the **Library API**'s broad read scopes to third-party apps in **March 2025**. An app
can no longer list somebody's library; it can only receive what a person explicitly hands it in
Google's own picker. That is the only supported route now, and it is a better shape for this
product anyway — we never browse anybody's photographs, we receive exactly the ones chosen.

The flow, which is unusual:

1. OAuth for one scope: `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
2. `POST /v1/sessions` → Google returns a `pickerUri` and a polling interval.
3. The organiser is sent to that URI and picks photographs in Google's interface.
4. We poll the session until `mediaItemsSet` is true — which may be twenty minutes later, because
   somebody is looking at photographs of their mother.
5. `GET /v1/mediaItems?sessionId=…` lists what they picked.
6. Each item's `baseUrl` is downloaded **immediately** with `=d` (the original file). Those URLs
   expire in about an hour.
7. The bytes go through the ordinary upload path — the same `recordUpload` and the same
   `ingest-asset` job as a phone upload — so a photograph from Google is indistinguishable from
   one a cousin sent, all the way through curation and rendering.

Steps 4–7 happen in the **worker**, not in a request. The organiser closes the tab, and the photos
appear.

---

## Setting it up (about ten minutes)

1. **Create a Google Cloud project** at <https://console.cloud.google.com>.

2. **Enable the Photos Picker API**: APIs & Services → Library → search "Photos Picker API" →
   Enable. (This is a different API from "Photos Library API"; enabling the wrong one produces a
   403 with `SERVICE_DISABLED` at the session-create step.)

3. **Configure the OAuth consent screen**: APIs & Services → OAuth consent screen.
   - User type **External** unless everyone using this deployment is in one Workspace.
   - App name, support email, developer email — these are shown to the family, so use the name
     they will recognise.
   - **Scopes**: add `.../auth/photospicker.mediaitems.readonly` and nothing else. Every extra
     scope is a sentence on the consent screen a grieving person has to read.

4. **Test users, and whether you need verification.** While the app is in _Testing_, only the
   Google accounts you list as test users can use it, and the consent screen carries an
   "unverified app" warning. That is fine for a funeral home running this for its own families —
   add the organisers as test users. Going to _Production_ with a sensitive scope means Google's
   verification review, which takes weeks and wants a privacy policy and a demo video. Plan for
   it well before you need it.

5. **Create the OAuth client**: Credentials → Create credentials → OAuth client ID → Web
   application. Add the redirect URI, exactly:

   ```
   https://your-domain.example/api/import/google/callback
   ```

   It must match `APP_BASE_URL` + `/api/import/google/callback` character for character —
   including https and no trailing slash. A mismatch is Google's `redirect_uri_mismatch` error,
   which the family sees on Google's page, not ours.

6. **Set the variables** on both the web app and the worker, and restart:

   ```
   GOOGLE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
   APP_BASE_URL=https://your-domain.example
   ```

Then walk it: open a memorial's collect screen, press **Bring photos from Google Photos**, pick
three photographs, and watch them appear in the grid.

---

## The credential tradeoff, stated plainly

The worker needs the access token to download the photographs, and the worker is a different
process from the one that received it. There are three ways to bridge that gap and each has a
cost:

| Option                                      | Cost                                                               |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Store the token in a database column        | A credential with a lifetime, in a backup, in a family's row       |
| Download inside the web request             | An organiser on a rural connection holding a request open for ages |
| **Pass it through the job payload, sealed** | An encrypted credential resting briefly in the jobs table          |

We chose the third. Specifically:

- The token is sealed with **AES-256-GCM**, keyed by SHA-256 over a purpose string and
  `SESSION_SECRET` (`packages/core/src/import/seal.ts`). The purpose is mixed into the key, so the
  state cookie and the token envelope cannot open each other.
- The envelope carries its own expiry — one hour, matching Google's token life.
- The moment the import finishes, successfully or not, the handler **blanks the sealed value out
  of the job row** (`sealedToken: 'used'`). What remains is the tally, which is what the collect
  screen reads.
- We request `access_type=online`, so there is never a refresh token. This product has no business
  holding a durable key to somebody's photo library. An import that has to be started again next
  week is a small price.
- Rotating `SESSION_SECRET` invalidates every envelope in flight. An import in progress is a fair
  thing to lose to a rotated secret.

The `state` that travels to Google is sealed the same way, ten-minute expiry, and is _also_ set as
an httpOnly cookie. Both must match on the way back, so a `state` replayed from anywhere else
lands on the front page with "that connection to Google did not finish" and no import.

---

## When it goes partly wrong

`baseUrl`s expire about an hour after they are listed. A large import can outlive them. Each
photograph is tried twice, and then given up on — the import is not failed, and the family is told
exactly what happened:

> We brought over 18 of 20 — Google let 2 links expire; pick them again and they will come through.

Other honest outcomes, all of them sentences rather than error codes:

| What happened                        | What the family sees                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| They pressed "no thanks" on Google   | "Nothing came over from Google, and nothing changed here."                   |
| The state did not match              | "That connection to Google did not finish. Starting it again usually works." |
| Nothing was picked in twenty minutes | "Nothing was picked in time. Starting again is all it takes."                |
| A PDF was among the picked items     | "…1 was not a photo or a video."                                             |

---

## What this feature never does

- It never lists, browses or searches anybody's library. It cannot: the scope does not allow it.
- It never stores a refresh token, and never asks for one.
- It never sends a family's photographs anywhere — the traffic is Google → this server, and the
  bytes land in the same blob store as every other upload, under `memorial/{id}/`.
- It is not required. Every deployment without those two variables is a complete product.
