/**
 * One question, at the end.
 *
 * Not a form, not a list of prompts — one question, which is the amount of
 * asking a person will actually do on a phone while standing in a kitchen. The
 * answer becomes a memory note, and in most families it is the thing that ends
 * up read aloud.
 */
import { unforgettableMomentPrompt } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { resolveToken } from '@/server/contributor';
import { LinkClosed } from '../LinkClosed';
import { saveMemoryAction, skipToThanksAction } from '../actions';
import styles from '../contributor.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'One memory' };

export default async function MemoryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = resolveToken(token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial } = resolved.context;
  const name = memorial.decedentKnownAs || memorial.decedentName;

  return (
    <StepScreen
      eyebrow={`For ${name}`}
      title={unforgettableMomentPrompt(name)}
      helper="A few sentences is plenty. However it comes out is right."
      footer="The family reads these. Nothing is published anywhere."
    >
      <form action={saveMemoryAction} className={styles.stack}>
        <input type="hidden" name="token" value={token} />
        <div>
          {/* The question is the page title; repeating it as a label would
              make a screen reader say it twice. */}
          <textarea
            id="memory"
            name="memory"
            aria-label={unforgettableMomentPrompt(name)}
            className={styles.memoryField}
            rows={7}
            placeholder="The first thing that came to mind is usually the one."
          />
        </div>
        <div>
          <button type="submit" className={step.primary}>
            Send this
          </button>
        </div>
      </form>

      <form action={skipToThanksAction} style={{ marginTop: '24px' }}>
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={step.quiet}>
          Not now
        </button>
      </form>
    </StepScreen>
  );
}
