'use client';

/**
 * Removing a speech, the way everything else is removed here: it goes, an Undo
 * sits there for eight seconds, and only then does it stand. No confirmation
 * dialog — that asks a tired person the same question twice and still leaves
 * them no way back.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { step } from '@/components/StepScreen';
import { useUndoToast } from '@/components/UndoToast';
import { removeSpeechAction, restoreSpeechAction } from '../actions';

export function RemoveSpeech({ memorialId, speechId }: { memorialId: string; speechId: string }) {
  const toast = useUndoToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const { message } = await removeSpeechAction(memorialId, speechId);
      toast.show({
        message,
        onUndo: async () => {
          await restoreSpeechAction(memorialId, speechId);
          router.refresh();
        },
        onExpire: () => router.push(`/m/${memorialId}/speeches`),
      });
      router.push(`/m/${memorialId}/speeches`);
    });
  }

  return (
    <button type="button" className={step.quiet} onClick={remove} disabled={pending}>
      Remove this speech
    </button>
  );
}
