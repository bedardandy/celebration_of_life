'use client';

/**
 * The upload control, as progressive enhancement.
 *
 * What renders on the server is a real form: a file input and a submit button
 * that POST straight to /api/upload and land on the notes page. That form is
 * the fallback, and it is also the thing that works on a nine-year-old phone
 * where the JavaScript never finishes loading.
 *
 * When JavaScript is available, Uppy takes over the same input and uploads in
 * the background with per-file progress, so nobody sits watching a white screen
 * wondering whether their forty photos are going anywhere. If Uppy fails to
 * load — old browser, blocked bundle, flaky train wifi — the form submit is
 * still wired up and nothing is lost.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
// Type-only: erased at build time, so no Uppy code is in the first payload.
import type { Uppy as UppyInstance } from '@uppy/core';
import { step } from '@/components/StepScreen';
import styles from '../contributor.module.css';

type FileState = {
  id: string;
  name: string;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  error?: string;
};

export function UploadArea({ token, nextHref }: { token: string; nextHref: string }) {
  const router = useRouter();
  const uppyRef = useRef<UppyInstance | undefined>(undefined);
  const [enhanced, setEnhanced] = useState(false);
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [{ default: Uppy }, { default: XHRUpload }] = await Promise.all([
          import('@uppy/core'),
          import('@uppy/xhr-upload'),
        ]);
        if (cancelled) return;

        const uppy = new Uppy({
          autoProceed: true,
          // One request per file: a failure loses one photo, not the batch.
          restrictions: { maxFileSize: 60 * 1024 * 1024 },
        }).use(XHRUpload, {
          endpoint: `/api/upload?token=${encodeURIComponent(token)}`,
          fieldName: 'files',
          formData: true,
          limit: 2,
          headers: { accept: 'application/json' },
        });

        uppy.on('upload-progress', (file, progress) => {
          if (!file) return;
          const total = progress.bytesTotal ?? 0;
          const pct = total ? Math.round((progress.bytesUploaded / total) * 100) : 0;
          setFiles((current) =>
            current.map((item) =>
              item.id === file.id ? { ...item, progress: pct, state: 'uploading' } : item,
            ),
          );
        });

        uppy.on('upload-success', (file) => {
          if (!file) return;
          setFiles((current) =>
            current.map((item) =>
              item.id === file.id ? { ...item, progress: 100, state: 'done' } : item,
            ),
          );
        });

        uppy.on('upload-error', (file) => {
          if (!file) return;
          setFiles((current) =>
            current.map((item) =>
              item.id === file.id
                ? { ...item, state: 'failed', error: 'That one did not go through.' }
                : item,
            ),
          );
        });

        uppy.on('complete', () => setBusy(false));

        uppyRef.current = uppy;
        setEnhanced(true);
      } catch {
        // The plain form is still there and still works. Say nothing.
        setEnhanced(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      uppyRef.current?.destroy?.();
      uppyRef.current = undefined;
    };
  }, [token]);

  function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
    const uppy = uppyRef.current;
    const chosen = Array.from(event.target.files ?? []);
    if (!uppy || chosen.length === 0) return;

    setBusy(true);
    setFiles((current) => [
      ...current,
      ...chosen.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        progress: 0,
        state: 'waiting' as const,
      })),
    ]);

    for (const file of chosen) {
      try {
        uppy.addFile({
          name: file.name,
          type: file.type || 'application/octet-stream',
          data: file,
          source: 'file-input',
        });
      } catch {
        setFiles((current) =>
          current.map((item) =>
            item.name === file.name
              ? { ...item, state: 'failed', error: 'That one did not go through.' }
              : item,
          ),
        );
      }
    }
    // The same input can be used again for a second batch.
    event.target.value = '';
  }

  const added = files.filter((f) => f.state === 'done').length;

  return (
    <>
      <form
        className={styles.stack}
        method="post"
        action={`/api/upload?token=${encodeURIComponent(token)}`}
        encType="multipart/form-data"
      >
        <input type="hidden" name="token" value={token} />
        <label className={styles.bigButton} htmlFor="files">
          Add photos
        </label>
        <div className={styles.fileRow}>
          <input
            id="files"
            className={styles.fileInput}
            type="file"
            name="files"
            multiple
            accept="image/*,video/*"
            onChange={enhanced ? onFilesChosen : undefined}
          />
        </div>
        {enhanced ? null : (
          <button type="submit" className={step.primary}>
            Send these photos
          </button>
        )}
      </form>

      {files.length > 0 ? (
        <ul className={styles.progressList}>
          {files.map((file) => (
            <li key={file.id} className={styles.progressItem}>
              <span className={styles.progressName}>{file.name}</span>
              <span
                className={`${styles.progressState} ${
                  file.state === 'done'
                    ? styles.progressDone
                    : file.state === 'failed'
                      ? styles.progressFailed
                      : ''
                }`}
              >
                {file.state === 'done'
                  ? 'Added'
                  : file.state === 'failed'
                    ? (file.error ?? 'Did not go through')
                    : `${file.progress}%`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {enhanced && added > 0 ? (
        <div className={styles.stack} style={{ marginTop: '28px' }}>
          <button
            type="button"
            className={step.primary}
            disabled={busy}
            onClick={() => router.push(nextHref)}
          >
            {busy ? 'Still sending…' : `Done — ${added} added`}
          </button>
        </div>
      ) : null}
    </>
  );
}
