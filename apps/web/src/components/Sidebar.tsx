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
  Lightbulb,
  Plug,
  PlugsConnected,
  Key,
  Brain,
  ClockCountdown,
  ShieldCheck,
  ListMagnifyingGlass,
  CurrencyDollar,
  GearSix,
  List,
  X,
  ArrowSquareOut,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import BrandMark from './ui/BrandMark';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import LiveCard from './ui/LiveCard';
import WorkspaceSwitcher from './WorkspaceSwitcher';
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
      { href: '/automations', label: 'Automation', icon: ClockCountdown },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck },
      { href: '/logs', label: 'Logs', icon: ListMagnifyingGlass },
    ],
  },
  {
    section: 'Workspace',
    items: [
      { href: 'https://discord.gg/7UZsvZPgU', label: 'Join Discord', external: true },
      { href: '/billing', label: 'Billing', icon: CurrencyDollar },
      { href: '/settings', label: 'Settings', icon: GearSix },
    ],
  },
];

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

  // Close mobile drawer on route change.
  useEffect(() => {
    queueMicrotask(() => setOpen(false));
  }, [pathname]);

  return (
    <>
      {/* Mobile top bar (lg breakpoint and below) */}
      <div className="fixed top-0 right-0 left-0 z-40 flex items-center justify-between border-b border-rule-2 bg-sidebar px-4 py-3.5 lg:hidden">
        <div className="flex items-center gap-2 text-[14px] font-medium tracking-[-0.005em] text-ink">
          <span className="flex h-[20px] w-[20px] items-center justify-center rounded-md bg-ink font-mono text-[10px] font-semibold text-canvas">
            N
          </span>
          <span>Nodal-Agents</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-ink-3 transition-colors hover:text-ink"
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X size={20} /> : <List size={20} />}
        </button>
      </div>

      {/* Backdrop on mobile */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar shell — 220px on desktop, slide-in drawer on mobile */}
      <aside
        className={`fixed top-0 left-0 z-40 flex h-full w-[220px] flex-col border-r border-rule-2 bg-sidebar pt-4 pb-3 transition-transform duration-200 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <BrandMark />
        <WorkspaceSwitcher workspaces={workspaces ?? []} />

        <nav className="flex flex-1 flex-col overflow-y-auto py-1.5">
          {NAV.map((group, gi) => (
            <div key={gi}>
              {group.section && <SidebarSection>{group.section}</SidebarSection>}
              {group.items.map((it) =>
                it.external ? (
                  // Discord — always Discord-blurple, external-link icon, new tab.
                  <a
                    key={it.href}
                    href={it.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group mx-2 flex h-[30px] items-center gap-2.5 rounded-lg bg-[#5865F2] px-2.5 text-[12.5px] font-medium leading-none text-white transition-[filter] hover:brightness-110"
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      <ArrowSquareOut size={14} weight="bold" />
                    </span>
                    <span className="flex-1 truncate">{it.label}</span>
                  </a>
                ) : (
                  <SidebarLink
                    key={it.href}
                    href={it.href}
                    label={it.label}
                    icon={it.icon ? <it.icon size={14} /> : undefined}
                    dot={it.dot}
                    count={it.href === '/approvals' ? undefined : it.count}
                    pill={
                      it.href === '/approvals' && pendingCount > 0
                        ? pendingCount
                        : undefined
                    }
                    isActive={
                      // The Home link must match exactly — every other route
                      // starts with `/`, so the default startsWith logic would
                      // mark Home as active everywhere.
                      it.href === '/'
                        ? pathname === '/'
                        : pathname === it.href || pathname.startsWith(it.href + '/')
                    }
                  />
                ),
              )}
            </div>
          ))}
        </nav>

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
