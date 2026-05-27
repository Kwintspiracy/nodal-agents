import type { ReactNode } from 'react';

type Props = {
  /** Left slot — typically a PillTabs2 selector. */
  tabs?: ReactNode;
  /** Right slot — typically a search box. */
  search?: ReactNode;
  /** Far-right slot — a primary CTA (coral / blue / ink). */
  cta?: ReactNode;
  /** Optional extra slot rendered between search and CTA (e.g. a filter
   *  dropdown). */
  extra?: ReactNode;
  className?: string;
};

/**
 * PageTopBar — the per-page header strip that sits BELOW the dashboard
 * Topbar and ABOVE the canvas. Maps to `.pg-tb` in the design bundle
 * (Skills / Connectors / Agent detail).
 *
 * Composes a left tabs slot, a centre search slot, optional extra slot,
 * and a right CTA. All slots are optional — pages compose what they
 * need without needing a variant prop. Sits flush in the page region
 * (no horizontal padding here — the dashboard layout's max-w wrapper
 * handles that).
 */
export default function PageTopBar({ tabs, search, cta, extra, className = '' }: Props) {
  return (
    <div className={`flex flex-wrap items-center gap-2.5 pt-4 ${className}`}>
      {tabs}
      <div className="flex-1" />
      {search}
      {extra}
      {cta}
    </div>
  );
}
