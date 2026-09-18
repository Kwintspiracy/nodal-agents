'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AttentionCount from './AttentionCount';
import SidebarRow from './SidebarRow';

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
  /** Opens in a new tab: a row that LEAVES the app (Documentation, Discord). */
  external?: boolean;
  /** Rendered hard right, after the label — the external-link arrow. */
  trailing?: ReactNode;
  /** Brand tint replacing the state background (the Discord button's blurple).
   *  Colour only: the row keeps every other row's shape. */
  tint?: string;
  /** The caret that folds whatever sits under this row. A sibling of the link
   *  inside the row, so hovering anywhere on the row lights all of it. */
  caret?: ReactNode;
};

const DOT_BG: Record<DotVariant, string> = {
  agent: 'bg-agent-vivid',
  skill: 'bg-skill-vivid',
  conn: 'bg-conn-vivid',
};

/**
 * SidebarLink — single nav row. Maps to `.side-link` in the design.
 *
 * Its shape, its hover and its active background come from `SidebarRow`, the
 * ONE row of the rail (2026-09-19): a nav entry, a folder and a thread are the
 * same row at three depths. What lives here is only what a nav entry carries
 * and the others do not — the meaning dot, the mono count, the attention pill.
 */
export default function SidebarLink({
  href,
  label,
  icon,
  dot,
  count,
  pill,
  isActive,
  external = false,
  trailing,
  tint,
  caret,
}: Props) {
  const pathname = usePathname();
  const active = isActive ?? (pathname === href || pathname.startsWith(href + '/'));

  return (
    <SidebarRow
      href={href}
      title={label}
      active={active}
      external={external}
      tint={tint}
      caret={caret}
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
          data-testid="nav-leading-icon"
          className={`flex h-5 w-5 shrink-0 items-center justify-center lg:h-3.5 lg:w-3.5 ${
            tint !== undefined ? '' : active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'
          }`}
        >
          {icon}
        </span>
      )}
      {/* leading-5 : `truncate` coupe le débordement, et la line box du
          `leading-none!` hérité de la ligne (13 px) rognerait les descendantes
          (g, y). `font-medium!` — la ligne ACTIVE reste grasse à toutes les
          tailles, y compris en `lg` où `text-body-13` rembarque un poids 400 ;
          sans le `!`, l'utilitaire de la rampe gagne l'égalité de spécificité. */}
      <span className={`flex-1 truncate leading-5 ${active ? 'font-medium!' : ''}`}>{label}</span>
      {pill !== undefined ? (
        // La MÊME pastille que les dossiers du menu Chat, depuis #135 — son
        // apparence « Approvals » (corail translucide, plafond 99) est le
        // défaut du primitif, justement pour que rien ne bouge ici.
        <AttentionCount count={pill} />
      ) : (
        count !== undefined && (
          <span className="text-mono-13 tracking-[0.02em] text-ink-4 lg:text-mono-11">{count}</span>
        )
      )}
      {trailing}
    </SidebarRow>
  );
}
