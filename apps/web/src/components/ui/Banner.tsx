import type { ReactNode } from 'react';
import { Info, Warning, Lightbulb } from '@phosphor-icons/react/dist/ssr';

type Variant = 'info' | 'warn' | 'tip';

const STYLE: Record<Variant, { bg: string; icon: string; iconColor: string }> = {
  info: {
    bg: 'bg-run-bg',
    icon: 'text-conn-vivid',
    iconColor: 'text-conn-vivid',
  },
  warn: {
    bg: 'bg-warn-bg',
    icon: 'text-skill-vivid',
    iconColor: 'text-skill-vivid',
  },
  tip: {
    bg: 'bg-paper border border-rule-2',
    icon: 'text-ink-3',
    iconColor: 'text-ink-3',
  },
};

const ICON: Record<Variant, typeof Info> = {
  info: Info,
  warn: Warning,
  tip: Lightbulb,
};

type Props = {
  variant: Variant;
  /** Bold lead, rendered on its own line. */
  title?: ReactNode;
  /** Body text or richer JSX. */
  children: ReactNode;
  className?: string;
};

/**
 * Banner — small contextual notice. Three variants mirror the design's
 * `.set-info` (blue), `.set-warn` (coral), and `.tip-banner` (paper)
 * patterns. Used across Settings, Connectors (post-OAuth), Agents
 * Hierarchy (tip header), and anywhere a one-line callout is needed.
 *
 * Geometry stays identical across variants — only colours change. That
 * keeps the visual rhythm consistent across pages even when the
 * sentiment differs.
 */
export default function Banner({ variant, title, children, className = '' }: Props) {
  const s = STYLE[variant];
  const Icon = ICON[variant];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-[9px] px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink-2 ${s.bg} ${className}`}
    >
      <Icon size={16} weight="regular" className={`mt-0.5 shrink-0 ${s.iconColor}`} />
      <div className="min-w-0 flex-1">
        {title && <b className="block font-medium text-ink">{title}</b>}
        {children}
      </div>
    </div>
  );
}
