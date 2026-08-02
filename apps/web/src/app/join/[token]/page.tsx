/**
 * "Anne has asked you to help with Ruth's celebration of life."
 *
 * One screen, two questions, and then they are simply in — the same dashboard
 * the organiser sees, with everything they can do. No account to make, no
 * password to choose, nothing to install, because the person opening this is
 * usually a sibling in another city who has agreed to take some of it on.
 *
 * The email is asked for one reason and the screen says so: it is how they get
 * back in if they lose this link.
 */
import {
  CO_ORGANIZER_JOIN_HELP,
  PRODUCT_NAME,
  firstNameOf,
  organizerDisplayName,
  resolveInviteToken,
} from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { LinkClosed } from '@/app/c/[token]/LinkClosed';
import { db } from '@/server/db';
import { joinAsCoOrganizerAction } from './actions';
import styles from './join.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Helping with a memorial' };

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = (await searchParams) ?? {};
  const resolved = resolveInviteToken(db(), token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial } = resolved.context;
  const who = firstNameOf(organizerDisplayName(db(), memorial.id));
  const name = memorial.decedentKnownAs || memorial.decedentName;

  return (
    <StepScreen
      eyebrow={PRODUCT_NAME}
      title={
        who
          ? `${who} has asked you to help remember ${name}.`
          : `You have been asked to help remember ${name}.`
      }
      helper="You will see everything they see, and you can do everything they can."
      footer={CO_ORGANIZER_JOIN_HELP}
    >
      {query['check'] === 'email' ? (
        <p className={step.error}>Please check the email address.</p>
      ) : null}
      {query['check'] === 'name' ? (
        <p className={step.error}>Please add your name, so the family knows who is helping.</p>
      ) : null}

      <form action={joinAsCoOrganizerAction} className={styles.stack}>
        <input type="hidden" name="token" value={token} />

        <div>
          <label htmlFor="name">Your first name</label>
          <input id="name" name="name" type="text" autoComplete="given-name" required />
        </div>

        <div>
          <label htmlFor="email">Your email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <p className={step.fieldHint}>
            Only so we can send you a way back in if you lose this link. Nothing else is sent to it.
          </p>
        </div>

        <div>
          <button type="submit" className={step.primary}>
            Start helping
          </button>
        </div>
      </form>
    </StepScreen>
  );
}
