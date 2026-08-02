'use client';

/**
 * Done, or not now.
 *
 * Two quiet buttons and an Undo — the same pattern as removing a photograph,
 * for the same reason. Nothing asks "are you sure?", because that makes a tired
 * person decide twice and still leaves them no way back.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
// Type-only, so none of @col/core's server code reaches the browser bundle.
import type { ReviewNoteStatus } from '@col/core';
import { step } from '@/components/StepScreen';
import { useUndoToast } from '@/components/UndoToast';
import { setNoteStatusAction } from './actions';

export function NoteActions({
  memorialId,
  noteId,
  status,
}: {
  memorialId: string;
  noteId: string;
  status: ReviewNoteStatus;
}) {
  const toast = useUndoToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(next: ReviewNoteStatus) {
    startTransition(async () => {
      const { message, previous } = await setNoteStatusAction(memorialId, noteId, next);
      router.refresh();
      toast.show({
        message,
        onUndo: async () => {
          await setNoteStatusAction(memorialId, noteId, previous);
          router.refresh();
        },
      });
    });
  }

  if (status !== 'open') {
    return (
      <button
        type="button"
        className={step.quiet}
        onClick={() => change('open')}
        disabled={pending}
      >
        Put this back
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={step.quiet}
        onClick={() => change('done')}
        disabled={pending}
      >
        Done
      </button>
      <button
        type="button"
        className={step.quiet}
        onClick={() => change('dismissed')}
        disabled={pending}
      >
        Not now
      </button>
    </>
  );
}
