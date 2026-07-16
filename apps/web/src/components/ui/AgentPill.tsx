import Link from 'next/link';

type Props = {
  /** Agent display name. */
  name: string;
  /** Destination — the pill is always a navigation link (sibling-agent switch). */
  href: string;
  /** Highlighted (current agent): paper fill + ink text. */
  active?: boolean;
};

/**
 * AgentPill — a rounded nav pill for one agent: a lime status dot + the agent
 * name, with an active (current) state. The sibling-agent switcher row at the
 * top of the agent edit page is a row of these.
 *
 * Extracted from AgentComposer's inline `AgentPicker` (DS: a dot+label nav pill
 * is a real reusable atom, not one-off inline markup — same reasoning as the
 * Tabs extraction). Distinct from the other pills: StatusPill (state chip),
 * PillTabs/PillTabs2 (segmented toggles), CountPill (count chip) — this one is a
 * standalone navigation pill.
 */
export default function AgentPill({ name, href, active = false }: Props) {
  return (
    <Link
      href={href}
      className={[
        'inline-flex h-[34px] items-center gap-2 rounded-full border px-3.5 text-medium-14 transition-colors',
        active
          ? 'border-rule-2 bg-paper text-ink'
          : 'border-rule bg-canvas text-ink-3 hover:border-rule-2 hover:text-ink-2',
      ].join(' ')}
    >
      <span className="inline-block h-[7px] w-[7px] rounded-full bg-agent-vivid" />
      {name}
    </Link>
  );
}
