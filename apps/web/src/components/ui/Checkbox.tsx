import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

type Tone = 'ink' | 'agent' | 'skill' | 'connector';

// Accent colour matches the entity being toggled — agent sub-agent/fallback
// pickers use the agent lime, skill assignment uses skill coral, connector/
// LLM-key toggles use connector blue; everything else (schedules, generic
// options) defaults to ink. Mirrors PrimaryButton's create-button colour
// convention (see its docstring).
const TONE_ACCENT: Record<Tone, string> = {
  ink: 'accent-ink',
  agent: 'accent-agent-vivid',
  skill: 'accent-skill-vivid',
  connector: 'accent-conn-vivid',
};

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  /** Rendered to the right of the checkbox, wrapped in the same clickable `<label>`. Omit for a bare checkbox (e.g. a table cell that already renders its own label). */
  label?: ReactNode;
  tone?: Tone;
  className?: string;
  containerClassName?: string;
};

/**
 * Checkbox — the checkbox+label pattern used for skill assignment
 * (AssignSkillModal), agent sub-agent/fallback pickers (AgentComposer/
 * ConnectorsTabContent), and toggle options (ScheduleForm's "notify on
 * success"). Canonical geometry: `h-4 w-4 shrink-0`, accent-coloured per
 * `tone` (audit UX-DS Phase 1 — 6 pre-existing accent colours collapsed to
 * one prop instead of one-off `className`s at each call site).
 */
export default function Checkbox({
  label,
  tone = 'ink',
  id,
  className = '',
  containerClassName = '',
  ...rest
}: Props) {
  const autoId = useId();
  const checkboxId = id ?? autoId;
  const input = (
    <input
      id={checkboxId}
      type="checkbox"
      className={`h-4 w-4 shrink-0 cursor-pointer rounded border-rule disabled:cursor-not-allowed disabled:opacity-50 ${TONE_ACCENT[tone]} ${className}`}
      {...rest}
    />
  );

  if (!label) return <div className={containerClassName}>{input}</div>;

  return (
    <label
      htmlFor={checkboxId}
      className={`flex cursor-pointer items-center gap-2 text-sm text-ink ${containerClassName}`}
    >
      {input}
      {label}
    </label>
  );
}
