'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { ModalFooter } from '@/components/ui/Modal';

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
    // SSR-safe portal gate: createPortal needs document, which is only present
    // after hydration. Setting state in this effect is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      <div className="relative bg-paper border border-rule-2 rounded-xl max-w-md w-full shadow-2xl">
        <div className="p-6">
          <h2 id="confirm-dialog-title" className="text-base font-semibold text-ink">
            {title}
          </h2>
          {message && <p className="mt-2 text-sm text-ink-3 leading-relaxed">{message}</p>}
        </div>
        {/* Same footer template as every other modal in the app (UX-B7):
            border separator, Cancel (neutral) then the confirm action last. */}
        <ModalFooter className="rounded-b-xl">
          <PrimaryButton variant="neutral" onClick={onCancel} ref={cancelRef}>
            {cancelLabel}
          </PrimaryButton>
          <PrimaryButton variant={destructive ? 'danger' : 'ink'} onClick={onConfirm}>
            {confirmLabel}
          </PrimaryButton>
        </ModalFooter>
      </div>
    </div>,
    document.body,
  );
}
