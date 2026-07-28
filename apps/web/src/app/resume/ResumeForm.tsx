'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { requestLinkAction, type ResumeState } from './actions';

export function ResumeForm({ signedOut }: { signedOut: boolean }) {
  const [state, formAction] = useActionState<ResumeState, FormData>(requestLinkAction, {});

  return (
    <form action={formAction}>
      <StepScreen
        title="We will send you a link"
        helper={
          signedOut
            ? 'Your last link has been used. Put your email in and we will send a new one.'
            : 'Put in the email address you used, and we will send a link straight back to your pages.'
        }
        primary={<SubmitButton />}
        secondary={
          <Link className={step.quiet} href="/">
            Back
          </Link>
        }
        footer="There is no password to remember. The link is all you need."
      >
        {state.error ? (
          <p className={step.error} role="alert">
            {state.error}
          </p>
        ) : null}
        <div className={step.field}>
          <label htmlFor="email">Your email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            defaultValue={state.email ?? ''}
            autoFocus
            required
          />
        </div>
      </StepScreen>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={step.primary} disabled={pending}>
      {pending ? 'Sending…' : 'Send me a link'}
    </button>
  );
}
