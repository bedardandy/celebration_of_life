/**
 * The page somebody lands on when a link has stopped working.
 *
 * This is not a 404. Somebody was asked to help, they tapped the link a week
 * later, and it did not open — the worst possible reading of that moment is
 * "you did something wrong", and the second worst is a page that says nothing.
 * So: what happened, what to do, and no suggestion that anything they already
 * sent has been lost.
 */
import { LINK_CLOSED_COPY, PRODUCT_NAME } from '@col/core';
import type { TokenRejection } from '@col/core';
import { StepScreen } from '@/components/StepScreen';

export function LinkClosed({ reason }: { reason: TokenRejection | 'gone' }) {
  const copy = LINK_CLOSED_COPY[reason] ?? LINK_CLOSED_COPY.revoked;
  return (
    <StepScreen
      eyebrow={PRODUCT_NAME}
      title={copy.title}
      helper={copy.body}
      footer="No account is needed here, so there is nothing for you to sign in to."
    />
  );
}
