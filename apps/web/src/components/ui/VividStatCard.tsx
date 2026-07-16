import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';

type Variant = 'agent' | 'skill' | 'conn';

/**
 * Background + text-colour mapping. Matches the `.h-stat` rules in the
 * design bundle: lime uses dark ink (best legibility on neon), the coral
 * and blue cards use white. Hover/active styling is identical so the
 * cards keep their strong block-of-colour feel.
 */
const VARIANT: Record<Variant, { bg: string; fg: string; muted: string; border: string }> = {
  agent: {
    bg: 'bg-agent-vivid',
    fg: 'text-[#0a0a0a]',
    muted: 'text-[#0a0a0a]/70',
    border: 'border-[#0a0a0a]/10',
  },
  skill: {
    bg: 'bg-skill-vivid',
    fg: 'text-white',
    muted: 'text-white/75',
    border: 'border-white/15',
  },
  conn: {
    bg: 'bg-conn-vivid',
    fg: 'text-white',
    muted: 'text-white/75',
    border: 'border-white/15',
  },
};

type Props = {
  variant: Variant;
  label: string;
  /** The big number / primary value. */
  value: string | number;
  /** Secondary descriptor under the big number ("12 running now"). Optional. */
  meta?: ReactNode;
  /** Bottom strip — small text plus optional arrow. Optional. */
  foot?: ReactNode;
  /** Icon for the label row. Pass a small svg or Phosphor icon. */
  icon?: ReactNode;
  /** When set, the whole card becomes a navigation link. */
  href?: string;
};

/**
 * VividStatCard — one of the three saturated cards on the Home dashboard.
 * The strict 3-colour identity belongs to this primitive: lime for Agents,
 * coral for Skills, blue for Connectors. Same colour MUST NOT be used as a
 * decorative accent elsewhere — that's what dilutes the signal in tools
 * we're trying to differentiate against.
 */
export default function VividStatCard({ variant, label, value, meta, foot, icon, href }: Props) {
  const v = VARIANT[variant];
  const inner = (
    <div
      className={`relative flex min-h-[172px] flex-col overflow-hidden rounded-2xl px-[18px] pt-4 pb-3.5 ${v.bg} ${v.fg}`}
    >
      <div
        className={`mb-2.5 flex items-center justify-between text-mono-11 uppercase tracking-[0.16em] ${v.muted}`}
      >
        <span className="flex items-center gap-2">
          {icon && (
            <span
              className={`flex h-[22px] w-[22px] items-center justify-center rounded-md ${variant === 'agent' ? 'bg-black/10' : 'bg-white/15'}`}
            >
              {icon}
            </span>
          )}
          {label}
        </span>
        {href && (
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full opacity-70 ${variant === 'agent' ? 'bg-black/10' : 'bg-white/15'}`}
          >
            <ArrowUpRight size={11} />
          </span>
        )}
      </div>
      <div className="mt-0.5 text-numeral-56 leading-none! tracking-[-0.03em]">{value}</div>
      {meta && <div className={`mt-1 text-body-14 leading-[1.3]! ${v.muted}`}>{meta}</div>}
      {foot && (
        <div
          className={`mt-auto flex items-center justify-between border-t pt-3 text-body-14 leading-none! ${v.border}`}
        >
          {foot}
        </div>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
