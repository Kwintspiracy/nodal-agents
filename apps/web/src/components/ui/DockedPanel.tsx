'use client';

import { useId, type ReactNode } from 'react';
import { useLayer } from '@/lib/layers.ts';
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
 *
 * Échap : ce panneau ne l'écoute pas pour son compte, il s'inscrit dans la
 * pile des calques (`@/lib/layers.ts`). La touche va au calque OUVERT LE PLUS
 * INTÉRIEUR, et à lui seul — une modale ouverte depuis le panneau se ferme
 * sans l'emporter, et un popover ouvert dans le panneau se ferme avant lui.
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
  const titleId = useId();

  useLayer(open, onClose);

  if (!open) return null;

  // Le repère est nommé par le titre RENDU (`aria-labelledby`) et non par un
  // `aria-label` calculé : un titre `ReactNode` laissait le repère sans nom.
  return (
    <aside
      role="complementary"
      aria-labelledby={titleId}
      data-testid={testId}
      className={`flex h-full shrink-0 flex-col overflow-hidden border-l border-rule-2 bg-paper ${className}`}
      style={{ width }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule-2 py-3 pr-3 pl-5">
        <h2 id={titleId} className="min-w-0 truncate text-title-16 text-ink">
          {title}
        </h2>
        <IconButton ghost aria-label="Close" onClick={onClose} className="h-7 w-7">
          <X size={16} />
        </IconButton>
      </div>

      {/* `tabIndex={0}` : un corps plus haut que le panneau se fait défiler au
          clavier même quand il ne contient rien de focalisable. */}
      <div
        tabIndex={0}
        className="flex min-h-px flex-1 flex-col gap-3.5 overflow-y-auto p-5 focus-visible:outline-none"
      >
        {children}
      </div>

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
