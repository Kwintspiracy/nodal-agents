'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

type DotVariant = 'agent' | 'skill' | 'conn';

type Props = {
  href: string;
  label: string;
  icon?: ReactNode;
  /** Coloured dot that replaces the icon. Used to mark Agent/Skill/Connector
   *  links per the design's "one colour per meaning" system. */
  dot?: DotVariant;
  /** Tiny right-aligned mono count, e.g. number of skills installed. */
  count?: number | string;
  /** Coral attention pill — renders a rounded badge with the given count
   *  using the error/attention colour token. Used for Approvals. */
  pill?: number;
  /** Override active matching — defaults to "pathname equals href or starts
   *  with href + '/'", which is the right behaviour for nested routes. */
  isActive?: boolean;
};

const DOT_BG: Record<DotVariant, string> = {
  agent: 'bg-agent-vivid',
  skill: 'bg-skill-vivid',
  conn: 'bg-conn-vivid',
};

/**
 * SidebarLink — single nav row. Maps to `.side-link` in the design.
 * The active state uses paper-coloured background so it always reads as
 * raised regardless of theme; the design specifies a small drop shadow.
 */
export default function SidebarLink({ href, label, icon, dot, count, pill, isActive }: Props) {
  const pathname = usePathname();
  const active = isActive ?? (pathname === href || pathname.startsWith(href + '/'));

  return (
    // Mobile-first sizing: 48px-tall, 15px rows are comfortable thumb targets
    // inside the full-screen menu; `lg:` reverts to the compact 30px desktop rail.
    <Link
      href={href}
      className={`group mx-2 flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] transition-colors lg:h-[30px] lg:gap-2.5 lg:rounded-lg lg:px-2.5 lg:text-[13px] lg:leading-none ${
        active
          ? 'bg-paper text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
          : 'text-ink-2 hover:bg-hover'
      }`}
    >
      {dot ? (
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center lg:h-3.5 lg:w-3.5">
          {/* Mobile: the real icon, so every roomy row reads consistently and
              the lime/orange/blue dots aren't lost on the light sidebar. Hidden
              on desktop, where the design intentionally shows only the dot. */}
          <span
            className={`lg:hidden ${active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}`}
          >
            {icon}
          </span>
          {/* The meaning dot: a ringed corner badge over the icon on mobile;
              the lone centred glyph (no ring) on desktop. */}
          <span
            className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar lg:static lg:h-2 lg:w-2 lg:ring-0 ${DOT_BG[dot]}`}
          />
        </span>
      ) : (
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center lg:h-3.5 lg:w-3.5 ${active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}`}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {pill !== undefined ? (
        <span className="rounded-full bg-err/12 px-2 py-0.5 text-[13px] font-medium text-err lg:px-1.5 lg:py-0 lg:text-[11px]">
          {pill > 99 ? '99+' : pill}
        </span>
      ) : (
        count !== undefined && (
          <span className="font-mono text-[13px] tracking-[0.02em] text-ink-4 lg:text-[11px]">
            {count}
          </span>
        )
      )}
    </Link>
  );
}
