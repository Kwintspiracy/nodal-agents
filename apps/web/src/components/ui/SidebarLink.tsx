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
    <Link
      href={href}
      className={`group mx-2 flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] leading-none transition-colors ${
        active
          ? 'bg-paper text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
          : 'text-ink-2 hover:bg-hover'
      }`}
    >
      {dot ? (
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_BG[dot]}`} />
      ) : (
        <span
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}`}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {pill !== undefined ? (
        <span className="rounded-full bg-err/12 px-1.5 text-[10px] font-medium text-err">
          {pill > 99 ? '99+' : pill}
        </span>
      ) : (
        count !== undefined && (
          <span className="font-mono text-[10px] tracking-[0.02em] text-ink-4">{count}</span>
        )
      )}
    </Link>
  );
}
