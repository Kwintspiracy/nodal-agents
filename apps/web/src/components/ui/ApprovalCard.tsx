import type { ReactNode } from 'react';

type Props = {
  /** Icon element displayed in the left gutter (e.g. a Clock icon). */
  icon?: ReactNode;
  /** Primary action text — the tool call or action description. */
  title: ReactNode;
  /** Agent name that issued the request. */
  agent?: string;
  /** Short context / subtitle line. */
  body?: ReactNode;
  /** Right-side metadata column (e.g. "impact", "SLA"). */
  meta?: ReactNode;
  /** Slot for action buttons (Deny / Approve or resolved note). */
  actions?: ReactNode;
  /**
   * Where the action buttons sit.
   *
   * `inline` (default) puts them in a `shrink-0` right column — right for one or
   * two buttons. With more, that column stops shrinking and squeezes the body
   * into an unreadable strip; `below` gives the body the full width and puts the
   * actions on their own row. Graduated consent (once / this tool / this server /
   * reject / always reject) is five buttons, hence this.
   */
  actionsPlacement?: 'inline' | 'below';
};

/**
 * ApprovalCard — card layout for a single approval request.
 * Maps to `.appr-card` from screen-ops design (lines 2271-2316).
 *
 * Geometry: icon gutter | body (title + subtitle) | meta | action buttons.
 * The icon gutter and meta column are optional.
 */
export default function ApprovalCard({
  icon,
  title,
  agent,
  body,
  meta,
  actions,
  actionsPlacement = 'inline',
}: Props) {
  const below = actionsPlacement === 'below';
  return (
    <div className="rounded-xl border border-rule-2 bg-paper p-5">
      <div className="flex items-start gap-4">
        {/* Left gutter — optional clock / alert icon */}
        {icon && <div className="mt-0.5 shrink-0 text-ink-3">{icon}</div>}

        {/* Body — title + agent/subtitle */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-medium-14 leading-snug! text-ink">{title}</span>
            {agent && <span className="text-mono-12 text-ink-4">{agent}</span>}
          </div>
          {body && <div className="text-xs text-ink-3">{body}</div>}
        </div>

        {/* Meta — right-side label column */}
        {meta && <div className="shrink-0 text-right text-body-12 text-ink-4">{meta}</div>}

        {/* Actions, inline variant — only viable for one or two buttons. */}
        {actions && !below && <div className="shrink-0">{actions}</div>}
      </div>

      {/* Actions, below variant — own row, body keeps the full width. */}
      {actions && below && <div className="mt-4 border-t border-rule pt-3">{actions}</div>}
    </div>
  );
}
