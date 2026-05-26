import type { ReactNode } from 'react';
import { CheckCircle, Warning } from '@phosphor-icons/react/dist/ssr';
import LiveDot from './LiveDot';

export type StatusVariant = 'done' | 'warn' | 'run' | 'idle';

/**
 * StatusPill — small coloured pill used in tables (Home activity, Skills
 * assignments, Connectors installed, …). Maps to `.spill` in the design
 * bundle plus the closely-related `.status-pill` / `.st-pill` patterns.
 *
 * Iconography defaults follow the design:
 *   - `done`  → CheckCircle on a lime tint  (`#3a6a18`)
 *   - `warn`  → Warning triangle on a coral tint  (`#a25620`)
 *   - `run`   → animated blue blip on a blue tint (no static icon)
 *   - `idle`  → no icon, neutral grey
 * Pass `label` to override the default text ("Done", "Attention", …).
 */
type Props = {
  variant: StatusVariant;
  label?: string;
  /** Override the icon — pass `null` to suppress the default. */
  icon?: ReactNode | null;
  className?: string;
};

const DEFAULT_LABEL: Record<StatusVariant, string> = {
  done: 'Done',
  warn: 'Attention',
  run: 'Running',
  idle: 'Idle',
};

const STYLE: Record<StatusVariant, string> = {
  done: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  run: 'bg-run-bg text-run',
  idle: 'bg-black/5 text-ink-3 dark:bg-white/5',
};

export default function StatusPill({ variant, label, icon, className = '' }: Props) {
  const text = label ?? DEFAULT_LABEL[variant];

  let resolvedIcon: ReactNode = null;
  if (icon !== undefined) {
    resolvedIcon = icon;
  } else if (variant === 'done') {
    resolvedIcon = <CheckCircle size={11} weight="regular" />;
  } else if (variant === 'warn') {
    resolvedIcon = <Warning size={11} weight="regular" />;
  } else if (variant === 'run') {
    resolvedIcon = <LiveDot variant="blue" size="sm" />;
  }

  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2.5 text-[11px] font-medium leading-none ${STYLE[variant]} ${className}`}
    >
      {resolvedIcon}
      {text}
    </span>
  );
}
