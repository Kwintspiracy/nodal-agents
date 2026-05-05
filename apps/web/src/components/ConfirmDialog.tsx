'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red destructive styling for the confirm button. Default true since most uses are deletes. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Designed confirmation modal — replaces window.confirm() everywhere in the app.
 * Dark-theme matching the dashboard. ESC and backdrop click cancel.
 * Focus traps to the cancel button on open (safer default for destructive actions).
 *
 * Rendered via portal to <body> so it escapes the layout/text-align of whatever
 * cell it was triggered from (e.g. a table row with text-right).
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open || !mounted) return null;

  const confirmClasses = destructive
    ? 'bg-red-600 hover:bg-red-500 text-white'
    : 'bg-white hover:bg-neutral-200 text-black';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 text-left"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative bg-neutral-900 border border-neutral-800/60 rounded-xl p-6 max-w-md w-full shadow-2xl">
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-white"
        >
          {title}
        </h2>
        {message && (
          <p className="mt-2 text-sm text-neutral-400 leading-relaxed">{message}</p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-300 rounded-lg hover:border-neutral-600 hover:text-white transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
