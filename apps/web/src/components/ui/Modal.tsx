'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional heading rendered above children. */
  title?: ReactNode;
  children: ReactNode;
  /**
   * Optional footer, rendered below children. Compose with the exported
   * `ModalFooter` helper (below) so every modal in the app shares the same
   * action-row layout — see its docstring for the convention. Modals with
   * no explicit save/cancel step (pure info, or state that saves itself,
   * like AssignSkillModal's toggle list) should still pass a `ModalFooter`
   * with a single "Close" action for visual consistency with the rest of
   * the site.
   */
  footer?: ReactNode;
  /** Extra Tailwind classes on the panel (e.g. custom max-w). */
  className?: string;
  /**
   * Whether the backdrop click, Esc, and corner ✕ can dismiss the modal.
   * Defaults to `true` (existing behaviour, e.g. VersionBadge-style info
   * modals).
   *
   * Product rule: any EDIT modal (mutable data, risk of losing in-progress
   * changes) must pass `dismissable={false}` — closing then only happens via
   * explicit Save/Cancel buttons in the modal's own content. Read-only /
   * informational modals keep the default `true`.
   */
  dismissable?: boolean;
}

/**
 * Modal — reusable portal modal used by all three marketplace grids
 * (Connectors, MCP, Skills). Renders via createPortal to <body> so it
 * escapes stacking context of the card grid.
 *
 * Backdrop: click → close. Esc → close. Body scroll locked while open.
 * Renders null when !open (no DOM footprint when closed).
 * Pass `dismissable={false}` to disable backdrop/Esc/✕ dismissal (edit forms).
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className = '',
  dismissable = true,
}: Props) {
  // SSR-safe portal gate — createPortal needs document, which is only present
  // after hydration. Setting state in this effect is intentional (same pattern
  // as ConfirmDialog).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Esc to close (skipped when non-dismissable) + body scroll lock.
  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissable) onClose();
    }
    window.addEventListener('keydown', handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, dismissable]);

  if (!open || !mounted) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 animate-[fadeIn_150ms_ease]"
        onClick={dismissable ? onClose : undefined}
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
              {dismissable && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="text-ink-3 hover:text-ink transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          <div className="p-6 pt-5">{children}</div>
          {footer}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * ModalFooter — THE footer template for every modal in the app (UX-B7).
 * Self-contained (owns its own `border-t border-rule-2` separator + padding)
 * so it renders identically whether it's passed to `Modal`'s `footer` prop
 * by the component that owns the `<Modal>` call site, or rendered directly
 * inside `children` by a nested component that only owns the form/actions
 * (e.g. ConnectorForm, McpEditForm) — either way there is exactly one
 * bordered action row at the bottom of the panel, never zero, never two.
 *
 * Layout convention (non-negotiable — this is what UX-B7 standardises):
 *   - `children` are the right-aligned action buttons, in DOM order
 *     secondary-first: Cancel/Close (`<PrimaryButton variant="neutral">`)
 *     THEN the primary action last, so it lands at the far right.
 *   - `danger`, if passed, is a single destructive action (Disconnect/
 *     Delete) rendered isolated on the LEFT, visually separated from the
 *     Cancel/Save group on the right.
 *   - Every button inside is a `PrimaryButton` — never a bare `<button>` or
 *     underlined text.
 *
 * Reference usage: NewMemoryModal (Cancel + Save), ConnectorForm (Disconnect
 * on the left via `danger`, Close on the right).
 */
export function ModalFooter({
  children,
  danger,
  className = '',
}: {
  /** Right-aligned buttons, secondary-first, primary last. */
  children: ReactNode;
  /** Isolated destructive action, rendered on the left. */
  danger?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 border-t border-rule-2 px-6 py-4 ${
        danger ? 'justify-between' : 'justify-end'
      } ${className}`}
    >
      {danger}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
