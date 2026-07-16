'use client';

import { useEffect, type ReactNode } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Which edge the panel slides in from. */
  side?: 'right' | 'left';
  /** Max panel width in px (the panel is 85% of the container, capped here). */
  width?: number;
  /** `fixed` overlays the whole viewport (default); `absolute` overlays only
   *  the nearest positioned ancestor — used by the chat, which scopes the
   *  history drawer to the thread area rather than the whole app. */
  position?: 'fixed' | 'absolute';
  className?: string;
  children: ReactNode;
};

/**
 * Drawer — a slide-over panel with a dimming backdrop. The reusable form of the
 * mobile conversation panel in the chat. Distinct from Modal (centered dialog):
 * a Drawer is anchored to a screen edge and is the pattern for side navigation,
 * filters, or a secondary list on narrow viewports.
 *
 * Backdrop click and Escape both close it. Renders nothing when closed. Not a
 * native <dialog> — a plain div overlay, consistent with the rest of the app's
 * overlays (Modal, ConfirmDialog).
 */
export default function Drawer({
  open,
  onClose,
  side = 'right',
  width = 320,
  position = 'fixed',
  className = '',
  children,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const edge = side === 'right' ? 'right-0 border-l' : 'left-0 border-r';

  return (
    <div className={`${position} inset-0 z-20 ${className}`}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        className={`absolute inset-y-0 ${edge} flex w-[85%] flex-col border-rule-2 bg-paper shadow-xl`}
        style={{ maxWidth: width }}
      >
        {children}
      </aside>
    </div>
  );
}
