'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { createMemorialAction, type CreateMemorialState } from './actions';

export function CreateMemorialForm() {
  const [state, formAction] = useActionState<CreateMemorialState, FormData>(
    createMemorialAction,
    {},
  );

  return (
    <form action={formAction}>
      <StepScreen
        title="Who are we remembering?"
        helper="Three things to start. Everything else can wait, and all of it can be changed."
        primary={<SubmitButton />}
        secondary={
          <Link className={step.quiet} href="/">
            Back
          </Link>
        }
        footer="We use your email only to send you a link back to these pages."
      >
        {state.error ? (
          <p className={step.error} role="alert">
            {state.error}
          </p>
        ) : null}

        <div className={step.field}>
          <label htmlFor="decedentName">Their name</label>
          <input
            id="decedentName"
            name="decedentName"
            type="text"
            autoComplete="off"
            defaultValue={state.values?.decedentName ?? ''}
            autoFocus
            required
          />
          <p className={step.fieldHint}>
            However you would say it out loud. You can add a nickname later.
          </p>
        </div>

        <div className={step.field}>
          <label htmlFor="organizerName">Your name</label>
          <input
            id="organizerName"
            name="organizerName"
            type="text"
            autoComplete="name"
            defaultValue={state.values?.organizerName ?? ''}
            required
          />
        </div>

        <div className={step.field}>
          <label htmlFor="organizerEmail">Your email</label>
          <input
            id="organizerEmail"
            name="organizerEmail"
            type="email"
            autoComplete="email"
            inputMode="email"
            defaultValue={state.values?.organizerEmail ?? ''}
            required
          />
          <p className={step.fieldHint}>This is how you get back in. There is no password.</p>
        </div>
      </StepScreen>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={step.primary} disabled={pending}>
      {pending ? 'Setting things up…' : 'Continue'}
    </button>
  );
}
