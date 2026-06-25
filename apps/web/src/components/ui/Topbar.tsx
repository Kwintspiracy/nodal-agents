import type { ReactNode } from 'react';
import { Plus } from '@phosphor-icons/react/dist/ssr';
import SearchBox from './SearchBox';
import ThemeToggle from './ThemeToggle';
import PrimaryButton from './PrimaryButton';
import NotificationsBell from '@/components/NotificationsBell';

type Props = {
  /** Optional breadcrumb / contextual content rendered at the left of the bar.
   *  Pages can drop a title or back-button here; defaults to empty so the
   *  search slides to the right by itself. */
  left?: ReactNode;
  /** CTA target. Defaults to `/agents` (the create-agent flow lives off the
   *  agents list page today). Override per-screen if a more specific target
   *  makes sense. */
  primaryHref?: string;
  primaryLabel?: string;
  /** When false, hide the "+ New agent" CTA (e.g. on screens where it would
   *  be redundant). The bell + theme toggle stay. */
  showPrimary?: boolean;
  /** When false, hide the search box (e.g. on screens with their own
   *  page-level search in PageTopBar). */
  showSearch?: boolean;
};

/**
 * Topbar — dashboard-wide header strip. Matches the design's `.home-tb`
 * pattern: optional left slot, flexible spacer, search, notifications, theme
 * toggle, primary CTA.
 *
 * Sits between the sidebar and the page content. Each page composes around it.
 *
 * Mobile responsiveness:
 *   - SearchBox (min-width 280px) is hidden below `md` — at 390px viewport
 *     it would push the bar past the screen and crush the icon buttons
 *     into deformed shapes. Search is recovered via the `/` shortcut on
 *     desktop and (future) a search-icon overlay on mobile.
 *   - The "+ New agent" CTA collapses to icon-only below `md` so the
 *     button stays square instead of stretching the bar.
 *   - Horizontal padding tightens from 36px (desktop) to 16px (mobile).
 */
export default function Topbar({
  left,
  primaryHref = '/agents',
  primaryLabel = 'New agent',
  showPrimary = true,
  showSearch = true,
}: Props) {
  return (
    // Desktop-only: on mobile the single header bar (Sidebar) carries the brand,
    // hamburger, notifications and theme — no second stacked bar.
    <div className="hidden h-[52px] shrink-0 items-center gap-2 px-4 md:gap-2.5 lg:flex lg:px-9">
      {left}
      <div className="flex-1" />
      {showSearch && <SearchBox className="hidden md:flex" />}
      <NotificationsBell />
      <ThemeToggle />
      {showPrimary && (
        <PrimaryButton
          variant="ink"
          href={primaryHref}
          aria-label={primaryLabel}
          title={primaryLabel}
        >
          <Plus size={13} weight="bold" />
          <span className="hidden md:inline">{primaryLabel}</span>
        </PrimaryButton>
      )}
    </div>
  );
}
