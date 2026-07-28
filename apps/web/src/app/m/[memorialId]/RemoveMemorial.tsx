'use client';

/**
 * The only destructive action in Phase 1, and the pattern for all the ones
 * after it: remove now, offer Undo for eight seconds, leave only after the
 * offer has gone unused. No confirmation dialog — that asks a tired person to
 * make the same decision twice and still gives them no way back.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { step } from '@/components/StepScreen';
import { useUndoToast } from '@/components/UndoToast';
import { removeMemorialAction, restoreMemorialAction } from './actions';

export function RemoveMemorial({ memorialId }: { memorialId: string }) {
  const toast = useUndoToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const { message } = await removeMemorialAction(memorialId);
      router.refresh();
      toast.show({
        message,
        onUndo: async () => {
          await restoreMemorialAction(memorialId);
          router.refresh();
        },
        onExpire: () => router.push('/'),
      });
    });
  }

  return (
    <button type="button" className={step.quiet} onClick={remove} disabled={pending}>
      Remove this memorial
    </button>
  );
}
