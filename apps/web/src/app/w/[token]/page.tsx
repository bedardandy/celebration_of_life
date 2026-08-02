/**
 * "In loving memory of Ruth Anne Kelleher."
 *
 * Somebody who could not be in the room has been sent a link. They may be
 * opening it at work, on a phone, next to other people; they may be about to
 * cry. So the page is one line, one video and nothing else: no sign-in, no
 * product, no suggestion that they should make one of these too.
 *
 * Nothing plays until they press play. That rule is absolute here — a tribute
 * video that starts on its own is the single worst thing this page could do.
 */
import {
  PRODUCT_NAME,
  describeLength,
  formatServiceDate,
  noteInvitation,
  notePrivacyLine,
  organizerDisplayName,
  resolveWatchToken,
} from '@col/core';
import { StepScreen } from '@/components/StepScreen';
import { LinkClosed } from '@/app/c/[token]/LinkClosed';
import { db } from '@/server/db';
import { NoteForm, WATCH_VIDEO_ID } from './NoteForm';
import styles from './watch.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'In loving memory' };

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = (await searchParams) ?? {};
  const resolved = resolveWatchToken(db(), token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial, render, allowDownload } = resolved.context;
  const name = memorial.decedentName;
  const src = render ? `/api/renders/${render.id}?watch=${encodeURIComponent(token)}` : undefined;
  const organizer = organizerDisplayName(db(), memorial.id);

  return (
    <StepScreen
      eyebrow={PRODUCT_NAME}
      title={`In loving memory of ${name}`}
      helper={
        render
          ? `A short film the family made${render.durationSec ? ` — ${describeLength(render.durationSec)}` : ''}.`
          : undefined
      }
      footer="This link was shared with you by the family. It is not listed anywhere, and nobody else can find it."
    >
      {memorial.serviceDate ? (
        <p className={styles.service}>
          The service is on {formatServiceDate(memorial.serviceDate, memorial.timezone)}.
        </p>
      ) : null}

      {render && src ? (
        <>
          <div className={styles.frame}>
            {/* No autoplay, no loop, no muted-autoplay trick. */}
            <video
              id={WATCH_VIDEO_ID}
              className={styles.video}
              src={src}
              poster={`/api/renders/${render.id}/poster?watch=${encodeURIComponent(token)}`}
              controls
              preload="metadata"
              playsInline
              aria-label={`Tribute video for ${name}`}
            />
          </div>

          {render.preset === 'draft360' ? (
            <p className={styles.note}>
              This is an early version, made quickly to check. The family will replace it with the
              full-quality one.
            </p>
          ) : null}

          <p className={styles.note}>Watch it as many times as you like. The link keeps working.</p>

          {allowDownload ? (
            <p>
              <a
                className={styles.download}
                href={`/api/renders/${render.id}?watch=${encodeURIComponent(token)}&download=1`}
              >
                Save a copy
              </a>
            </p>
          ) : null}

          {/* Only the family sees these, and the form says so before anybody
              types. Nothing a viewer writes is ever shown to another viewer. */}
          <NoteForm
            token={token}
            invitation={noteInvitation(organizer)}
            privacyLine={notePrivacyLine(organizer)}
            sent={query['sent'] === '1'}
          />
        </>
      ) : (
        <p className={styles.waiting}>
          The video is not ready yet. The family is still putting it together — keep this link, and
          try again later. Nothing about it will change.
        </p>
      )}
    </StepScreen>
  );
}
