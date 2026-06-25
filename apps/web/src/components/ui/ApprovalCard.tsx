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
};

/**
 * ApprovalCard — card layout for a single approval request.
 * Maps to `.appr-card` from screen-ops design (lines 2271-2316).
 *
 * Geometry: icon gutter | body (title + subtitle) | meta | action buttons.
 * The icon gutter and meta column are optional.
 */
export default function ApprovalCard({ icon, title, agent, body, meta, actions }: Props) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-rule-2 bg-paper p-5">
      {/* Left gutter — optional clock / alert icon */}
      {icon && <div className="mt-0.5 shrink-0 text-ink-3">{icon}</div>}

      {/* Body — title + agent/subtitle */}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium leading-snug text-ink">{title}</span>
          {agent && <span className="font-mono text-[12px] text-ink-4">{agent}</span>}
        </div>
        {body && <div className="text-xs text-ink-3">{body}</div>}
      </div>

      {/* Meta — right-side label column */}
      {meta && <div className="shrink-0 text-right text-[12px] text-ink-4">{meta}</div>}

      {/* Actions — deny / approve buttons or resolved note */}
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
