import Link from 'next/link';
import type { ReactNode } from 'react';

type Props = {
  /** Agent display name. */
  name: string;
  /** Destination — the pill is always a navigation link (sibling-agent switch). */
  href: string;
  /** Highlighted (current agent): paper fill + ink text. */
  active?: boolean;
  /**
   * `md` (default) is the 34px switcher pill; `sm` the 26px pill that sits in
   * a list row, next to the folder it names (Sandbox section, #876).
   */
  size?: 'md' | 'sm';
  /**
   * `warn` says the agent escapes something the row promises — in the Sandbox
   * section, an agent whose runtime runs its commands outside the sandbox.
   * The reason goes in `title` and in a sentence next to the row, never in
   * the colour alone.
   */
  tone?: 'default' | 'warn';
  /** Tooltip: the reason behind a `warn` tone. */
  title?: string;
  /** A small glyph after the name (the warn triangle). */
  trailing?: ReactNode;
};

const SIZE = {
  md: 'h-[34px] gap-2 px-3.5 text-medium-14',
  sm: 'h-[26px] gap-1.5 px-2.5 text-medium-12',
} as const;

/**
 * AgentPill — a rounded nav pill for one agent: a lime status dot + the agent
 * name, with an active (current) state. The sibling-agent switcher row at the
 * top of the agent edit page is a row of these; the Sandbox section lists the
 * agents of a folder with the `sm` size.
 *
 * Extracted from AgentComposer's inline `AgentPicker` (DS: a dot+label nav pill
 * is a real reusable atom, not one-off inline markup — same reasoning as the
 * Tabs extraction). Distinct from the other pills: StatusPill (state chip),
 * PillTabs/PillTabs2 (segmented toggles), CountPill (count chip) — this one is a
 * standalone navigation pill.
 */
export default function AgentPill({
  name,
  href,
  active = false,
  size = 'md',
  tone = 'default',
  title,
  trailing,
}: Props) {
  const colour =
    tone === 'warn'
      ? 'border-warn/40 bg-warn-bg text-warn'
      : active
        ? 'border-rule-2 bg-paper text-ink'
        : 'border-rule bg-canvas text-ink-3 hover:border-rule-2 hover:text-ink-2';
  return (
    <Link
      href={href}
      title={title}
      className={[
        'inline-flex items-center rounded-full border transition-colors',
        SIZE[size],
        colour,
      ].join(' ')}
    >
      <span className="inline-block h-[7px] w-[7px] rounded-full bg-agent-vivid" />
      {name}
      {trailing}
    </Link>
  );
}
