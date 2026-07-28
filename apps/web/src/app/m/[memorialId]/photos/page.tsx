/**
 * "Share this link with family."
 *
 * The most valuable screen in the product, because it is the one that turns one
 * exhausted person's job into fifteen people's small favours. Three things, in
 * this order: the link (with a QR code, because half of the family will be
 * standing in a room together after the funeral), the words to send with it,
 * and a way to ask one named person for one specific thing.
 */
import Link from 'next/link';
import QRCode from 'qrcode';
import {
  ASK_TEMPLATES,
  COLLECTION_LINK_HELP,
  REVOKE_LINK_HELP,
  ensureCollectionLink,
  listCollectionLinks,
  messageDrafts,
  type CollectionLink,
} from '@col/core';
import { and, countWhere, eq, isNull, listWhere, mediaAssets, participants } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { CopyBox } from './CopyBox';
import { createAskAction, newCollectionLinkAction, revokeLinkAction } from './actions';
import styles from './photos.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Collect photos' };

export default async function PhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = await searchParams;
  const { memorial, participant } = await requireOrganizer(memorialId);

  // Made on first arrival rather than behind a button: a screen whose whole
  // purpose is "send this link" should not open with a button that makes one.
  ensureCollectionLink(db(), memorialId);
  const links = listCollectionLinks(db(), memorial);
  const familyLink = links.find((l) => l.row.kind === 'collection-link' && l.active);
  const asks = links.filter((l) => l.row.kind === 'contributor');

  const photoCount = countWhere(
    db(),
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
  );

  const recent = listWhere(
    db(),
    mediaAssets,
    and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    24,
  ).sort((a, b) => b.createdAt - a.createdAt);

  const names = new Map(
    listWhere(db(), participants, eq(participants.memorialId, memorialId)).map((p) => [
      p.id,
      p.displayName ?? 'Someone',
    ]),
  );

  const drafts = familyLink?.url
    ? messageDrafts({
        decedentName: memorial.decedentName,
        knownAs: memorial.decedentKnownAs,
        link: familyLink.url,
        organizerName: participant.displayName,
        deadlineAt: memorial.serviceDate,
        timezone: memorial.timezone,
      })
    : [];

  const qr = familyLink?.url ? await qrSvg(familyLink.url) : undefined;

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Share this link with family"
      helper="Anyone who has it can add photos and memories. Nobody needs an account."
      footer={
        <div className={styles.footerRow}>
          <span>
            {photoCount === 0
              ? 'Photos will appear here as they arrive.'
              : `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} so far.`}
          </span>
          <Link href={`/m/${memorialId}`}>Back to the dashboard</Link>
        </div>
      }
    >
      {query['revoked'] ? (
        <p className={styles.notice}>That link has been turned off. Photos already shared stay.</p>
      ) : null}

      <section className={styles.panel} id="links">
        {familyLink?.url ? (
          <div className={styles.linkRow}>
            <div className={styles.linkMain}>
              <CopyBox label="Your family link" value={familyLink.url} />
              <p className={styles.help}>{COLLECTION_LINK_HELP}</p>
              <form action={revokeLinkAction} className={styles.inlineForm}>
                <input type="hidden" name="memorialId" value={memorialId} />
                <input type="hidden" name="tokenId" value={familyLink.row.id} />
                <button type="submit" className={step.quiet}>
                  Turn this link off
                </button>
                <span className={styles.help}>{REVOKE_LINK_HELP}</span>
              </form>
            </div>
            {qr ? (
              <figure className={styles.qr}>
                {/* Rendered on the server, so there is no second request. */}
                <div className={styles.qrCode} dangerouslySetInnerHTML={{ __html: qr }} />
                <figcaption className={styles.qrCaption}>
                  Point a phone camera at this — useful when everyone is in one room.
                </figcaption>
              </figure>
            ) : null}
          </div>
        ) : (
          <form action={newCollectionLinkAction} className={styles.inlineForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <button type="submit" className={step.primary}>
              Make a new family link
            </button>
            <span className={styles.help}>
              The old one has been turned off. Everything already shared is still here.
            </span>
          </form>
        )}
      </section>

      {drafts.length > 0 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Something to send with it</h2>
          <p className={styles.help}>
            Written for you. Change anything you like, or send it exactly as it is.
          </p>
          <div className={styles.drafts}>
            {drafts.map((draft) => (
              <CopyBox
                key={draft.id}
                label={draft.subject ? `${draft.label} — ${draft.subject}` : draft.label}
                value={draft.body}
                multiline={draft.id === 'email'}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.panel} id="delegate">
        <h2 className={styles.panelTitle}>Ask one person for one thing</h2>
        <p className={styles.help}>
          Small asks get answered. This makes a link of its own, with your request on it.
        </p>

        {query['ask'] === 'name' ? (
          <p className={styles.notice}>A name is all we need to make the link.</p>
        ) : null}

        <form action={createAskAction} className={styles.askForm}>
          <input type="hidden" name="memorialId" value={memorialId} />

          <div className={styles.field}>
            <label htmlFor="name">Who are you asking?</label>
            <input id="name" name="name" type="text" placeholder="Aunt Mary" required />
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>What would help most?</legend>
            <div className={styles.choices}>
              {ASK_TEMPLATES.map((template, index) => (
                <label key={template.slug} className={styles.choice}>
                  <input
                    type="radio"
                    name="template"
                    value={template.slug}
                    defaultChecked={index === 0}
                  />
                  <span>
                    <strong>{template.label}</strong>
                    <span className={styles.choiceHint}>{template.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className={styles.field}>
            <label htmlFor="focus">If it is a particular time or thing, what is it?</label>
            <input id="focus" name="focus" type="text" placeholder="the boat, her twenties" />
          </div>

          <div className={styles.field}>
            <label htmlFor="deadline">By when would help? (optional)</label>
            <input id="deadline" name="deadline" type="date" />
            <p className={step.fieldHint}>
              This is only a nudge in the message. Their link keeps working afterwards.
            </p>
          </div>

          <button type="submit" className={step.primary}>
            Make their link
          </button>
        </form>
      </section>

      {asks.length > 0 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>People you have asked</h2>
          <ul className={styles.askList}>
            {asks.map((ask) => (
              <AskRow
                key={ask.row.id}
                memorialId={memorialId}
                ask={ask}
                justMade={query['made'] === ask.row.id}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>What has arrived</h2>
          <ul className={styles.arrivals}>
            {recent.map((asset) => (
              <li key={asset.id} className={styles.arrival}>
                {asset.ingestState === 'ready' && !asset.mime.startsWith('video/') ? (
                    <img
                    className={styles.arrivalThumb}
                    src={`/api/assets/${asset.id}?variant=thumb320`}
                    alt={asset.originalFilename ?? 'A photo someone added'}
                    width={72}
                    height={72}
                    loading="lazy"
                  />
                ) : (
                  <span className={styles.arrivalPending} aria-hidden="true" />
                )}
                <span className={styles.arrivalWho}>
                  {asset.uploadedByParticipantId
                    ? (names.get(asset.uploadedByParticipantId) ?? 'Someone')
                    : 'Someone'}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.help}>
            <Link href={`/m/${memorialId}/curate`}>Go through the photos</Link> whenever you are
            ready. Nothing has to be decided today.
          </p>
        </section>
      ) : null}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>If the photos are not on a phone</h2>

        <details className={styles.detail}>
          <summary className={styles.summary}>Printed photos and albums</summary>
          <div className={styles.detailBody}>
            <p>
              A phone photo of a print is genuinely good enough. Lay the print flat in daylight,
              turn the flash off, and hold the phone straight above it.
            </p>
            <p>
              For a whole album, Google&nbsp;PhotoScan (free, iPhone and Android) removes the glare
              by taking four passes. It is slower per photo, and worth it for the ones that matter.
            </p>
          </div>
        </details>

        <details className={styles.detail}>
          <summary className={styles.summary}>Photos in iCloud</summary>
          <div className={styles.detailBody}>
            <p>
              On an iPhone: open Photos, tap Select, choose the ones you want, then Share and Save
              to Files — or simply open the family link and pick them straight from the library.
            </p>
            <p>
              On a computer: sign in at iCloud.com, open Photos, select and download. They arrive as
              HEIC files, which this page handles.
            </p>
          </div>
        </details>

        <details className={styles.detail}>
          <summary className={styles.summary}>Photos on Facebook</summary>
          <div className={styles.detailBody}>
            <p>
              Facebook can send you a copy of your own photos: Settings &rarr; Your information
              &rarr; Download your information, choose Photos and videos, and pick the highest
              quality. It takes a while to arrive by email.
            </p>
            <p>
              For a handful of photos it is faster to open each one and save it, or to ask whoever
              posted it — they usually have the original.
            </p>
          </div>
        </details>
      </section>
    </StepScreen>
  );
}

function AskRow({
  memorialId,
  ask,
  justMade,
}: {
  memorialId: string;
  ask: CollectionLink;
  justMade: boolean;
}) {
  return (
    <li className={`${styles.askItem} ${justMade ? styles.askItemNew : ''}`}>
      <div className={styles.askHead}>
        <strong>{ask.label ?? 'Someone'}</strong>
        <span className={styles.askStatus}>
          {!ask.active
            ? 'Turned off'
            : ask.photoCount === 0 && ask.memoryCount === 0
              ? 'Nothing yet'
              : `${ask.photoCount} ${ask.photoCount === 1 ? 'photo' : 'photos'}${
                  ask.memoryCount > 0 ? `, ${ask.memoryCount} written` : ''
                }`}
        </span>
      </div>
      <p className={styles.askBody}>{ask.ask.body}</p>
      {ask.ask.deadlineLine ? <p className={styles.help}>{ask.ask.deadlineLine}</p> : null}
      {ask.active && ask.url ? (
        <>
          <CopyBox label={`Link for ${ask.label ?? 'them'}`} value={ask.url} />
          <form action={revokeLinkAction} className={styles.inlineForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="tokenId" value={ask.row.id} />
            <button type="submit" className={step.quiet}>
              Turn this link off
            </button>
          </form>
        </>
      ) : null}
      {ask.active && !ask.url ? (
        <p className={styles.help}>
          This link cannot be shown again on this server. Making a new ask will produce a fresh one.
        </p>
      ) : null}
    </li>
  );
}

/**
 * The QR code as inline SVG: no image endpoint, no client library, and it
 * prints properly on the back of an order of service.
 */
async function qrSvg(url: string): Promise<string | undefined> {
  try {
    return await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 200,
      color: { dark: '#33302c', light: '#fffdfa' },
    });
  } catch {
    return undefined;
  }
}
