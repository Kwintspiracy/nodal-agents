import type { ReactNode } from 'react';
import SearchBox from './SearchBox';
import ThemeToggle from './ThemeToggle';
import NotificationsBell from '@/components/NotificationsBell';

type Props = {
  title: ReactNode;
  /** Single-line subtitle / lede. Falls under the h1 with 14px ink-3 text. */
  subtitle?: ReactNode;
};

/**
 * PageHeader — THE one header bar every dashboard page wears (the Figma "TopBar").
 * It doubles as the page title: the h1 + lede sit on the left; the global
 * controls (search · notifications · theme) sit on the right; a bottom rule
 * separates it from the body. NO create/CTA button ever lives here.
 *
 * It spans the FULL width of the content pane (edge to edge, right of the
 * sidebar) — exactly like the old dashboard top bar — so it is always rendered
 * by `PageShell`, never nested inside the max-width body. Don't use it directly;
 * use `PageShell` so every page gets the identical header + a consistent body.
 *
 * The global controls are desktop-only (`lg`): on mobile the Sidebar's top bar
 * already carries notifications + theme, so we never stack them twice — but the
 * title stays visible at every width.
 */
export default function PageHeader({ title, subtitle }: Props) {
  return (
    // FULL-WIDTH bar: title hard-left, global controls hard-right, edge to edge
    // (like the old top bar) + a bottom rule. There is NEVER a create/CTA button
    // in the navbar — page actions live in the body toolbar (PageTopBar).
    <header className="flex items-center justify-between gap-4 border-b border-rule-2 px-5 pt-5 pb-4 sm:px-8 lg:px-9">
      <div className="min-w-0 flex-1">
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">{subtitle}</p>}
      </div>
      <div className="hidden shrink-0 items-center gap-2 lg:flex">
        <SearchBox className="hidden md:flex" />
        <NotificationsBell />
        <ThemeToggle />
      </div>
    </header>
  );
}
