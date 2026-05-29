'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional heading rendered above children. */
  title?: ReactNode;
  children: ReactNode;
  /** Extra Tailwind classes on the panel (e.g. custom max-w). */
  className?: string;
}

/**
 * Modal — reusable portal modal used by all three marketplace grids
 * (Connectors, MCP, Skills). Renders via createPortal to <body> so it
 * escapes stacking context of the card grid.
 *
 * Backdrop: click → close. Esc → close. Body scroll locked while open.
 * Renders null when !open (no DOM footprint when closed).
 */
export default function Modal({ open, onClose, title, children, className = '' }: Props) {
  // SSR-safe portal gate — createPortal needs document, which is only present
  // after hydration. Setting state in this effect is intentional (same pattern
  // as ConfirmDialog).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Esc to close + body scroll lock.
  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 animate-[fadeIn_150ms_ease]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Centered panel container — pointer-events-none so clicks on the
          transparent wrapper fall through to the backdrop above. */}
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div
          className={`pointer-events-auto w-full max-w-lg max-h-[90vh] overflow-y-auto bg-paper border border-rule-2 rounded-xl shadow-2xl animate-[scaleIn_150ms_ease] ${className}`}
        >
          {title !== undefined && (
            <div className="flex items-center justify-between gap-2 px-6 pt-5 pb-4 border-b border-rule-2">
              <h3 className="text-sm font-semibold text-ink">{title}</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-ink-3 hover:text-ink transition-colors"
              >
                ✕
              </button>
            </div>
          )}
          <div className="p-6 pt-5">{children}</div>
        </div>
      </div>
    </>,
    document.body,
  );
}
