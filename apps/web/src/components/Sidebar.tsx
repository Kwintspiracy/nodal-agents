'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  House,
  ChatCircle,
  Graph,
  Sparkle,
  UsersThree,
  BookOpenText,
  BookOpen,
  Lightbulb,
  Plug,
  PlugsConnected,
  Key,
  Brain,
  ClockCountdown,
  ShieldCheck,
  ListMagnifyingGlass,
  GearSix,
  List,
  X,
  ArrowSquareOut,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import IconButton from './ui/IconButton';
import BrandMark from './ui/BrandMark';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import LiveCard from './ui/LiveCard';
import VersionBadge from './VersionBadge';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import ThemeToggle from './ui/ThemeToggle';
import NotificationsBell from './NotificationsBell';
import { useApprovals } from './ApprovalsProvider';
import type { WorkspaceRow } from '@/lib/actions';

type Item = {
  href: string;
  label: string;
  icon?: PhosphorIcon;
  dot?: 'agent' | 'skill' | 'conn';
  count?: number | string;
  /** External link — rendered as a plain <a> (new tab) with its own styling. */
  external?: boolean;
  /** Brand-specific external styling. 'discord' → the blurple button; a plain
   *  external link (e.g. Documentation) renders like a normal SidebarLink row. */
  brand?: 'discord';
};

type Group = { section?: string; items: Item[] };

/**
 * Nav structure — reconciles the design bundle's 4-section organization
 * with the routes that actually exist in `app/(dashboard)/`.
 *
 * Anything in the existing tool stays in the sidebar even if the design
 * bundle dropped it (Credentials, Billing) — per the design-system rule
 * "respect existing functionalities". The design's reorganization that
 * IS applied: 4 named sections (Overview/Build/Operate/Workspace) and
 * the coloured dot beside Agents/Skills/Connectors links.
 */
const NAV: Group[] = [
  {
    section: 'Overview',
    items: [
      { href: '/', label: 'Home', icon: House },
      { href: '/chat', label: 'Chat', icon: ChatCircle },
      { href: '/jobs', label: 'Runs', icon: Graph },
      { href: '/llm-providers', label: 'LLM Providers', icon: Sparkle },
    ],
  },
  {
    section: 'Build',
    items: [
      { href: '/agents', label: 'Agents', icon: UsersThree, dot: 'agent' },
      { href: '/skills', label: 'Skills', icon: BookOpenText, dot: 'skill' },
      { href: '/learned-skills', label: 'Learned Skills', icon: Lightbulb },
      { href: '/connectors', label: 'API Connectors', icon: Plug, dot: 'conn' },
      { href: '/mcp', label: 'MCP Connectors', icon: PlugsConnected, dot: 'conn' },
      { href: '/credentials', label: 'Credentials', icon: Key },
      { href: '/memories', label: 'Memory', icon: Brain },
    ],
  },
  {
    section: 'Operate',
    items: [
      { href: '/automations', label: 'Automations & Webhooks', icon: ClockCountdown },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck },
      { href: '/logs', label: 'Logs', icon: ListMagnifyingGlass },
    ],
  },
  {
    section: 'Workspace',
    items: [
      {
        href: 'https://discord.gg/7UZsvZPgU',
        label: 'Join Discord',
        external: true,
        brand: 'discord',
      },
      {
        href: 'https://kwintspiracy.github.io/nodal-agents/',
        label: 'Documentation',
        icon: BookOpen,
        external: true,
      },
      { href: '/settings', label: 'Settings', icon: GearSix },
    ],
  },
];

/** Home matches exactly; every other route is active on prefix match. */
function isItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export default function Sidebar({
  workspaces,
  userMenu,
}: {
  workspaces?: WorkspaceRow[];
  userMenu?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { pending } = useApprovals();
  const pendingCount = pending.length;

  // Close mobile menu on route change.
  useEffect(() => {
    queueMicrotask(() => setOpen(false));
  }, [pathname]);

  // While the full-screen mobile menu is open, lock body scroll and let Escape
  // dismiss it — standard dialog etiquette so the page behind doesn't move and
  // keyboard users can always back out. No-op on desktop (menu never "opens").
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      {/* Mobile header bar (lg and below) — the single mobile nav strip:
          hamburger (opens the full-screen menu) + brand on the left, the global
          actions (notifications, theme) on the right. The desktop <Topbar> is
          hidden on mobile so there is exactly ONE bar, not two stacked ones. */}
      <header className="fixed top-0 right-0 left-0 z-40 flex h-16 items-center gap-1 border-b border-rule-2 bg-sidebar px-2 lg:hidden">
        <IconButton
          ghost
          onClick={() => setOpen(true)}
          className="h-12 w-12 rounded-xl hover:bg-hover active:bg-hover"
          aria-label="Open menu"
          aria-controls="primary-nav"
          aria-expanded={open}
        >
          <List size={26} />
        </IconButton>
        <div className="flex min-w-0 items-center gap-2 pl-1 text-medium-15 tracking-[-0.005em] text-ink">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-ink font-mono text-label-11 text-canvas">
            N
          </span>
          <span className="truncate">Nodal-Agents</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <ThemeToggle />
        </div>
      </header>

      {/* One shell for both form factors:
            • Mobile (≤lg): a FULL-SCREEN menu. A 220px drawer wastes a phone's
              width, so the menu owns the whole viewport with roomy, thumb-sized
              rows. Slides in from the left; `-translate-x-full` parks it off-screen.
            • Desktop (lg+): the classic fixed 220px rail, always visible.
          Keeping a single tree means NAV and the user/sign-out block render once
          (no duplicate routes, no duplicate test ids). */}
      <aside
        id="primary-nav"
        aria-label="Main navigation"
        className={`fixed top-0 left-0 z-50 flex h-full w-full flex-col border-r border-rule-2 bg-sidebar pt-4 pb-3 transition-transform duration-200 ease-out lg:z-40 lg:w-[244px] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Mobile: brand + close share one centred row, so the ✕ sits in the
            top-right corner perfectly level with the "Nodal-Agents" wordmark. */}
        <div className="flex items-center justify-between px-4 pb-1 lg:hidden">
          <div className="flex min-w-0 items-center gap-2 text-legacy-16 font-medium tracking-[-0.005em] text-ink">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink font-mono text-legacy-12 font-semibold text-canvas">
              N
            </span>
            <span className="truncate">Nodal-Agents</span>
          </div>
          <IconButton
            ghost
            onClick={() => setOpen(false)}
            className="-mr-2 h-10 w-10 rounded-xl hover:bg-hover active:bg-hover"
            aria-label="Close menu"
          >
            <X size={24} />
          </IconButton>
        </div>

        {/* Desktop: the standard brand block (close button collapses away). */}
        <div className="hidden lg:block">
          <BrandMark />
        </div>

        <WorkspaceSwitcher workspaces={workspaces ?? []} />

        <nav className="flex flex-1 flex-col overflow-y-auto py-1.5">
          {NAV.map((group, gi) => (
            <div key={gi}>
              {group.section && <SidebarSection>{group.section}</SidebarSection>}
              {group.items.map((it) =>
                it.external && it.brand === 'discord' ? (
                  // Discord — always Discord-blurple, external-link icon, new tab.
                  // Sizing mirrors SidebarLink: roomy on mobile, compact on desktop.
                  <a
                    key={it.href}
                    href={it.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group mx-3 flex h-12 items-center gap-3 rounded-xl bg-[#5865F2] px-3 text-medium-15 text-white transition-[filter] hover:brightness-110 lg:h-[30px] lg:gap-2.5 lg:rounded-lg lg:px-3 lg:text-medium-13 lg:leading-none!"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center lg:h-3.5 lg:w-3.5">
                      <ArrowSquareOut
                        size={20}
                        weight="bold"
                        className="h-5 w-5 lg:h-3.5 lg:w-3.5"
                      />
                    </span>
                    <span className="flex-1 truncate leading-5">{it.label}</span>
                  </a>
                ) : it.external ? (
                  // Plain external link (e.g. Documentation) — mirrors SidebarLink's
                  // inactive row styling, opens in a new tab, with a small external
                  // arrow at the end so it reads as "leaves the app".
                  <a
                    key={it.href}
                    href={it.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group mx-3 flex h-12 items-center gap-3 rounded-xl px-3 text-legacy-16 text-ink-2 transition-colors hover:bg-hover lg:h-[30px] lg:gap-2.5 lg:rounded-lg lg:px-3 lg:text-body-13 lg:leading-none!"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-3 group-hover:text-ink-2 lg:h-3.5 lg:w-3.5">
                      {it.icon ? <it.icon size={20} className="h-5 w-5 lg:h-3.5 lg:w-3.5" /> : null}
                    </span>
                    <span className="flex-1 truncate leading-5">{it.label}</span>
                    <ArrowSquareOut
                      size={14}
                      weight="bold"
                      className="h-3.5 w-3.5 shrink-0 text-ink-4 lg:h-3 lg:w-3"
                    />
                  </a>
                ) : (
                  <SidebarLink
                    key={it.href}
                    href={it.href}
                    label={it.label}
                    icon={
                      it.icon ? (
                        <it.icon size={20} className="h-5 w-5 lg:h-3.5 lg:w-3.5" />
                      ) : undefined
                    }
                    dot={it.dot}
                    count={it.href === '/approvals' ? undefined : it.count}
                    pill={it.href === '/approvals' && pendingCount > 0 ? pendingCount : undefined}
                    isActive={isItemActive(it.href, pathname)}
                  />
                ),
              )}
            </div>
          ))}
        </nav>

        {/* Version + update nudge — sits right after the nav (Settings is the
            last item). Shows the running version; surfaces an update badge when
            npm has a newer one. */}
        <VersionBadge />

        {/* Live card slot — hidden until we wire real telemetry, but the
            primitive is in place for Phase 2 / 3 to switch on. */}
        <LiveCard runningAgents={undefined} />

        {userMenu && (
          <div className="mt-2 border-t border-rule-2 px-3 pt-3" data-testid="user-menu">
            {userMenu}
          </div>
        )}
      </aside>
    </>
  );
}
