import type { ReactNode } from 'react';

type Props = {
  title: ReactNode;
  /** Single-line subtitle / lede. Falls under the h1 with 13px ink-3 text. */
  subtitle?: ReactNode;
  /** Optional right-aligned slot — e.g. a status pill, a CTA, or metadata. */
  actions?: ReactNode;
  className?: string;
};

/**
 * PageHeader — canonical page title block. The h1 + lede pattern shared by
 * every dashboard page (Home / Stats / Settings / Skills / Connectors / ...).
 *
 * Pages that own a `PageTopBar` (pill-tabs row) render this header ABOVE it,
 * so the visual order top-to-bottom is:
 *   Topbar (dashboard chrome) → PageHeader (h1 + lede) → PageTopBar (tabs)
 *     → page content.
 *
 * One source of truth for h1 sizing keeps the whole product consistent —
 * one tweak here and every page tracks.
 */
export default function PageHeader({ title, subtitle, actions, className = '' }: Props) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-4 pt-7 pb-5 ${className}`}>
      <div className="min-w-0 flex-1">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
