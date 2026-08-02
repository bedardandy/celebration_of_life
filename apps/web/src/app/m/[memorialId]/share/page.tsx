/**
 * "Share the work with someone."
 *
 * Almost nobody should be doing this alone, and in most families there is
 * already somebody asking what they can do. One decision on this screen: make a
 * link, or turn one off.
 *
 * The screen says plainly what the link is — the organiser's own access, handed
 * over — because a capability URL that is described vaguely is a capability URL
 * somebody forwards to a group chat.
 */
import Link from 'next/link';
import {
  CO_ORGANIZER_INVITE_HELP,
  CO_ORGANIZER_INVITE_OFFER,
  listCoOrganizerInvites,
} from '@col/core';
import { listWhere, participants, eq, and } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { CopyBox } from '../photos/CopyBox';
import { createInviteAction, revokeInviteAction } from './actions';
import styles from './share.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Share the work' };

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const invites = listCoOrganizerInvites(db(), memorialId).filter((invite) => invite.active);
  const organizers = listWhere(
    db(),
    participants,
    and(eq(participants.memorialId, memorialId), eq(participants.role, 'organizer')),
  ).filter((person) => person.revokedAt == null);

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Share the work with someone"
      helper={CO_ORGANIZER_INVITE_OFFER}
      primary={
        invites.length === 0 ? (
          <form action={createInviteAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <button type="submit" className={step.primary}>
              Make a link to share
            </button>
          </form>
        ) : undefined
      }
      secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      footer="Nothing anybody has already added changes. You keep your own way in."
    >
      {query['off'] === '1' ? (
        <p className={styles.notice}>
          That link has been turned off. Anyone already helping stays — they have their own way in
          now.
        </p>
      ) : null}

      {invites.map((invite) => (
        <section key={invite.row.id} className={styles.panel}>
          {query['made'] === '1' ? (
            <p className={styles.notice}>Here is the link. Send it to whoever is helping you.</p>
          ) : null}

          {invite.url ? (
            <CopyBox label="Link to share the work" value={invite.url} />
          ) : (
            <p className={styles.help}>
              This link cannot be shown again on this server. Making a new one takes a moment.
            </p>
          )}

          <p className={styles.help}>{CO_ORGANIZER_INVITE_HELP}</p>

          <form action={revokeInviteAction} className={styles.inlineForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="tokenId" value={invite.row.id} />
            <button type="submit" className={step.quiet}>
              Turn this link off
            </button>
          </form>
        </section>
      ))}

      {organizers.length > 1 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Helping with this</h2>
          <ul className={styles.people}>
            {organizers.map((person) => (
              <li key={person.id}>{person.displayName ?? 'Someone helping'}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </StepScreen>
  );
}
