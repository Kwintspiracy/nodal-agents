import type { ReactNode } from 'react';
import { Bell, Plus } from '@phosphor-icons/react/dist/ssr';
import SearchBox from './SearchBox';
import IconButton from './IconButton';
import ThemeToggle from './ThemeToggle';
import PrimaryButton from './PrimaryButton';

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
 */
export default function Topbar({
  left,
  primaryHref = '/agents',
  primaryLabel = 'New agent',
  showPrimary = true,
  showSearch = true,
}: Props) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 px-9">
      {left}
      <div className="flex-1" />
      {showSearch && <SearchBox />}
      <IconButton aria-label="Notifications" title="Notifications" badge>
        <Bell size={15} />
      </IconButton>
      <ThemeToggle />
      {showPrimary && (
        <PrimaryButton variant="ink" href={primaryHref}>
          <Plus size={13} weight="bold" />
          {primaryLabel}
        </PrimaryButton>
      )}
    </div>
  );
}
