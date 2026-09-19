'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import IconButton from './IconButton';

type Props = {
  /** Controlled by the parent. When false the component renders nothing. */
  open: boolean;
  /** Called by the close button and by Escape. */
  onClose: () => void;
  /** Heading shown at the top of the panel. */
  title: ReactNode;
  /** Panel width in px. The board (Figma P1) draws 400. */
  width?: number;
  /** Optional action row at the bottom, typically Cancel / Save. */
  footer?: ReactNode;
  /** Stable anchor for tests and e2e, posed on the element carrying the role. */
  testId?: string;
  className?: string;
  children: ReactNode;
};

/**
 * DockedPanel — an inspector docked to the right edge, full height, that
 * PUSHES the page instead of covering it.
 *
 * Distinct from `Drawer` and `Modal`, which both overlay the page behind a
 * dimming backdrop and trap the reader inside. A docked panel has no backdrop:
 * the list on its left stays visible and stays clickable, so the reader can
 * walk from one row to the next without closing anything. That is the whole
 * point of the pattern (Figma P1, issue #231) and the reason this is a third
 * component rather than a `Drawer` variant.
 *
 * Layout contract: the panel is a flex child sized in px, so its parent must be
 * the row that holds the page content and the panel side by side — typically
 * `<div className="flex ..."><main className="flex-1 min-w-0">…</main><DockedPanel/></div>`.
 * The panel takes `h-full` from that row, which is what puts it under the page
 * header rather than over it.
 *
 * Nothing here knows about settings, files or any one caller: the title, the
 * body and the footer all come from props, so the same component serves every
 * list that opens a form on the right.
 */
export default function DockedPanel({
  open,
  onClose,
  title,
  width = 400,
  footer,
  testId,
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

  return (
    <aside
      role="complementary"
      aria-label={typeof title === 'string' ? title : undefined}
      data-testid={testId}
      // Le trait de gauche porte `rule`, PAS `rule-2` : c'est la seule chose
      // qui sépare le panneau de la page, et en thème sombre `rule-2` ne se
      // voyait plus — les deux fonds se touchaient sans frontière (Quentin,
      // 19/09). Les traits INTÉRIEURS gardent `rule-2` : ils découpent, ils ne
      // séparent pas deux surfaces.
      className={`flex h-full shrink-0 flex-col overflow-hidden border-l border-rule bg-paper ${className}`}
      style={{ width }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule-2 py-3 pr-3 pl-5">
        <h2 className="min-w-0 truncate text-title-16 text-ink">{title}</h2>
        <IconButton ghost aria-label="Close" onClick={onClose} className="h-7 w-7">
          <X size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-px flex-1 flex-col gap-3.5 overflow-y-auto p-5">{children}</div>

      {footer !== undefined && (
        <div
          data-slot="footer"
          className="flex shrink-0 items-center justify-end gap-2 border-t border-rule-2 px-5 py-3"
        >
          {footer}
        </div>
      )}
    </aside>
  );
}
