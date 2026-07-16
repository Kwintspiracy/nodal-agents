import type { ReactNode } from 'react';

type Props = {
  /** Primary message — the ~20 existing copies all render exactly one line
   *  here (e.g. "No connectors installed yet."). */
  title: ReactNode;
  /** Optional secondary, quieter line below the title. */
  description?: ReactNode;
  /** Optional CTA rendered below the text (e.g. a PrimaryButton). */
  action?: ReactNode;
  /** Tighter padding for use inside an already-boxed area. Default matches
   *  every existing copy (py-12). */
  compact?: boolean;
  className?: string;
};

/**
 * EmptyState — the "nothing here yet" block duplicated ~20× across
 * list/table pages (audit UX-B1), always the same
 * `rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center` shell
 * with a `text-[14px] leading-[1.5] text-ink-3` message and, sometimes, a
 * `mt-4 inline-flex` CTA below it (see ConnectorsClient's "Browse
 * Marketplace" empty state). Geometry here is lifted verbatim from those
 * copies, not invented — it's the version every one of them already agreed
 * on.
 */
export default function EmptyState({
  title,
  description,
  action,
  compact = false,
  className = '',
}: Props) {
  return (
    <div
      className={`rounded-2xl border border-rule-2 bg-paper px-6 text-center ${compact ? 'py-8' : 'py-12'} ${className}`}
    >
      <p className="text-body-14 leading-[1.5]! text-ink-3">{title}</p>
      {description && <p className="mt-1 text-legacy-12-5 text-ink-4">{description}</p>}
      {action && <div className="mt-4 inline-flex">{action}</div>}
    </div>
  );
}
