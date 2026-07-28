'use client';

/**
 * Undo.
 *
 * Everything removable in this product is removed softly: the row is
 * tombstoned, this toast appears, and for eight seconds one tap puts it back.
 * When the toast goes, the removal simply stands — a later purge does the real
 * deleting. Nothing here asks "are you sure?", because a confirmation dialog
 * asks a tired person to make the same decision twice and still gives them no
 * way back if they get it wrong.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { UNDO_WINDOW_SEC } from '@col/core/ui';
import styles from './UndoToast.module.css';

export type UndoToastRequest = {
  message: string;
  /** Puts it back. Anything thrown here is swallowed; see `onUndoFailed`. */
  onUndo: () => void | Promise<void>;
  /** Runs when the window closes without an undo. The removal now stands. */
  onExpire?: () => void;
  /** Seconds the offer stays up. Defaults to the shared undo window. */
  seconds?: number;
};

type ToastApi = { show: (request: UndoToastRequest) => void };

const ToastContext = createContext<ToastApi | undefined>(undefined);

export function useUndoToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useUndoToast must be used inside <ToastProvider>');
  return api;
}

type ActiveToast = UndoToastRequest & { id: number };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | undefined>();

  const show = useCallback((request: UndoToastRequest) => {
    setToast({ ...request, id: Date.now() });
  }, []);

  const close = useCallback(() => setToast(undefined), []);
  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region}>
        {toast ? <UndoToast key={toast.id} toast={toast} onClose={close} /> : null}
      </div>
    </ToastContext.Provider>
  );
}

function UndoToast({ toast, onClose }: { toast: ActiveToast; onClose: () => void }) {
  const seconds = toast.seconds ?? UNDO_WINDOW_SEC;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      toast.onExpire?.();
      onClose();
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [toast, seconds, onClose]);

  async function undo() {
    if (busy) return;
    setBusy(true);
    try {
      await toast.onUndo();
    } finally {
      onClose();
    }
  }

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <p className={styles.message}>{toast.message}</p>
      <button type="button" className={styles.undo} onClick={undo} disabled={busy}>
        Undo
      </button>
      <button type="button" className={styles.dismiss} onClick={onClose}>
        Dismiss
      </button>
    </div>
  );
}
