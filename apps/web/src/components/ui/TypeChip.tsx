import type { ReactNode } from 'react';

export type TypeVariant = 'agent' | 'skill' | 'conn';

type Props = {
  variant: TypeVariant;
  label: string;
  icon?: ReactNode;
  className?: string;
};

/**
 * TypeChip — small coloured chip that names which entity a row refers to.
 * Maps to `.tchip` in the design bundle. The colour mapping is the
 * same one used everywhere: lime = Agent, coral = Skill, blue = Connector.
 *
 * Mirrors StatusPill geometry but with a softer background — TypeChip
 * names "what is this", StatusPill names "what's happening".
 */
const STYLE: Record<TypeVariant, string> = {
  agent: 'bg-agent-vivid/40 text-ink-2 dark:bg-agent-vivid/20 dark:text-agent-vivid',
  skill: 'bg-skill-vivid/15 text-warn dark:bg-skill-vivid/20 dark:text-skill-vivid',
  conn: 'bg-conn-vivid/15 text-run dark:bg-conn-vivid/20 dark:text-[#8aa8ff]',
};

export default function TypeChip({ variant, label, icon, className = '' }: Props) {
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2.5 text-medium-12 leading-none! ${STYLE[variant]} ${className}`}
    >
      {icon && <span className="opacity-70 [&_svg]:h-[11px] [&_svg]:w-[11px]">{icon}</span>}
      {label}
    </span>
  );
}
