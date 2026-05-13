'use client';

import { useState, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChartPieSlice,
  UsersThree,
  ClipboardText,
  Brain,
  Plug,
  Key,
  BookOpenText,
  ClockCountdown,
  ListMagnifyingGlass,
  ShieldCheck,
  List,
  X,
  GearSix,
  CurrencyDollar,
  type Icon,
} from '@phosphor-icons/react';

type NavItem = { href: string; label: string; icon: Icon };
type NavGroup = { section: string | null; items: NavItem[] };

const NAV_ITEMS: NavGroup[] = [
  {
    section: null,
    items: [
      { href: '/stats', label: 'Stats', icon: ChartPieSlice },
      { href: '/agents', label: 'Agents', icon: UsersThree },
    ],
  },
  {
    section: 'Data',
    items: [
      { href: '/jobs', label: 'Jobs', icon: ClipboardText },
      { href: '/memories', label: 'Memories', icon: Brain },
      { href: '/connectors', label: 'Connectors', icon: Plug },
      { href: '/credentials', label: 'Credentials', icon: Key },
      { href: '/skills', label: 'Skills', icon: BookOpenText },
    ],
  },
  {
    section: 'Automation',
    items: [
      { href: '/automations', label: 'Automations', icon: ClockCountdown },
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

export default function Sidebar({ userMenu }: { userMenu?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close on route change (microtask to avoid React 19 setState-in-effect warning)
  useEffect(() => {
    const id = queueMicrotask(() => setOpen(false));
    return () => void id;
  }, [pathname]);

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 py-4 bg-neutral-950 border-b border-neutral-800/50">
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-500 font-mono text-sm">$</span>
          <span className="text-sm font-mono font-bold text-white tracking-tight">
            nodal-agents
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-neutral-400 hover:text-white transition-colors"
          aria-label="Toggle menu"
        >
          {open ? <X size={20} /> : <List size={20} />}
        </button>
      </div>

      {/* Mobile overlay */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setOpen(false)} />
      )}

      {/* Sidebar panel */}
      <aside
        className={`fixed top-0 left-0 h-full z-40 w-56 bg-neutral-950 border-r border-neutral-800/50 flex flex-col transition-transform duration-200
          ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        {/* Logo */}
        <div className="flex items-center gap-1.5 px-5 py-5 border-b border-neutral-800/50">
          <span className="text-emerald-500 font-mono text-sm">$</span>
          <span className="text-sm font-mono font-bold text-white tracking-tight">
            nodal-agents
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {NAV_ITEMS.map((group, gi) => (
            <div key={gi} className="mb-4">
              {group.section && (
                <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
                  {group.section}
                </p>
              )}
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');
                const IconComp = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
                      active
                        ? 'bg-neutral-800/60 text-white font-medium'
                        : 'text-neutral-400 hover:text-white hover:bg-neutral-800/30'
                    }`}
                  >
                    <IconComp size={16} weight={active ? 'fill' : 'regular'} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* User menu slot — bottom of the sidebar */}
        {userMenu && (
          <div className="border-t border-neutral-800/50 p-3" data-testid="user-menu">
            {userMenu}
          </div>
        )}
      </aside>
    </>
  );
}
