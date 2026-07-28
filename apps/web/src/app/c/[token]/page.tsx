/**
 * "You're helping remember Ruth."
 *
 * The first thing a contributor sees. It has to do three things in one screen:
 * say whose it is, say exactly what was asked of them, and get out of the way.
 * There is no account, no password and no explanation of what this product is —
 * they were asked by a person, not by us.
 */
import { PRODUCT_NAME } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { currentContributor, resolveToken } from '@/server/contributor';
import { LinkClosed } from './LinkClosed';
import { saveNameAction } from './actions';
import styles from './contributor.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Helping remember someone' };

export default async function ContributorLanding({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = resolveToken(token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial, ask } = resolved.context;
  const name = memorial.decedentKnownAs || memorial.decedentName;
  const known = await currentContributor(resolved.context);

  return (
    <StepScreen
      eyebrow={PRODUCT_NAME}
      title={`You're helping remember ${name}.`}
      helper="No account, no app. Whatever you add goes straight to the family."
      footer="You can come back to this link any time — it keeps working."
    >
      <section className={styles.ask}>
        <h2 className={styles.askHeading}>{ask.heading}</h2>
        <p className={styles.askBody}>{ask.body}</p>
        {ask.suggestedCount || ask.deadlineLine ? (
          <p className={styles.askMeta}>
            {[ask.suggestedCount, ask.deadlineLine].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </section>

      <form action={saveNameAction} className={styles.stack}>
        <input type="hidden" name="token" value={token} />
        <div>
          <label htmlFor="name">What should we call you?</label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="given-name"
            defaultValue={known?.displayName ?? ''}
            placeholder="Your first name"
          />
          <p className={step.fieldHint}>
            So the family knows who to thank. You can leave it blank.
          </p>
        </div>
        <div>
          <button type="submit" className={step.primary}>
            Start adding photos
          </button>
        </div>
      </form>
    </StepScreen>
  );
}
