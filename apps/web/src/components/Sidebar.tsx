'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  House,
  Graph,
  Sparkle,
  UsersThree,
  BookOpenText,
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
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import BrandMark from './ui/BrandMark';
import FleetPicker, { type Fleet } from './ui/FleetPicker';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import LiveCard from './ui/LiveCard';

type Item = {
  href: string;
  label: string;
  icon?: PhosphorIcon;
  dot?: 'agent' | 'skill' | 'conn';
  count?: number | string;
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
      { href: '/jobs', label: 'Runs', icon: Graph },
      { href: '/llm-providers', label: 'LLM Providers', icon: Sparkle },
    ],
  },
  {
    section: 'Build',
    items: [
      { href: '/agents', label: 'Agents', icon: UsersThree, dot: 'agent' },
      { href: '/skills', label: 'Skills', icon: BookOpenText, dot: 'skill' },
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
      { href: '/billing', label: 'Billing', icon: CurrencyDollar },
      { href: '/settings', label: 'Settings', icon: GearSix },
    ],
  },
];

// Single-workspace placeholder. Once a real `fleets` table exists, this
// list moves to a server-fetched prop and the picker becomes interactive.
const FLEETS: Fleet[] = [{ id: 'local', name: 'Local workspace', tag: 'LCL', color: '#d4ff2e' }];

export default function Sidebar({ userMenu }: { userMenu?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

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
        <FleetPicker fleets={FLEETS} activeId={FLEETS[0]!.id} disabled />

        <nav className="flex flex-1 flex-col overflow-y-auto py-1.5">
          {NAV.map((group, gi) => (
            <div key={gi}>
              {group.section && <SidebarSection>{group.section}</SidebarSection>}
              {group.items.map((it) => (
                <SidebarLink
                  key={it.href}
                  href={it.href}
                  label={it.label}
                  icon={it.icon ? <it.icon size={14} /> : undefined}
                  dot={it.dot}
                  count={it.count}
                  isActive={
                    // The Home link must match exactly — every other route
                    // starts with `/`, so the default startsWith logic would
                    // mark Home as active everywhere.
                    it.href === '/'
                      ? pathname === '/'
                      : pathname === it.href || pathname.startsWith(it.href + '/')
                  }
                />
              ))}
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
