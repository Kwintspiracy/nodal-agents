/**
 * MonoMicroTag — rounded-full uppercase mono micro-badge (h-18).
 * Tones: `err` (coral), `skill` (lime), `warn` (amber) on a /10 tint of the
 * tone; `agent` (the Agent entity colour, light/dark split copied from
 * TypeChip because agent-vivid text is illegible on paper in light mode);
 * `ink` (neutral, for provenance/state flags with no entity colour).
 *
 * The inline flag that sits next to a setting label ("irreversible", "beta",
 * "experimental", skill provenance). Distinct from TagMini (squared, semibold,
 * sits inside SetRow values) and StatusPill (larger state chip). Extracted
 * from five identical inline spans across AgentComposer and
 * AutoRunPauseSection.
 */
type Tone = 'err' | 'skill' | 'warn' | 'agent' | 'ink';

const TONES: Record<Tone, string> = {
  err: 'bg-err/10 text-err',
  skill: 'bg-skill-vivid/10 text-skill-vivid',
  warn: 'bg-warn/10 text-warn',
  agent: 'bg-agent-vivid/40 text-ink-2 dark:bg-agent-vivid/20 dark:text-agent-vivid',
  ink: 'bg-ink/10 text-ink-3',
};

export function MonoMicroTag({
  tone,
  children,
  className = '',
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={[
        'inline-flex h-[18px] items-center rounded-full px-2',
        'text-mono-11 uppercase tracking-[0.1em]',
        TONES[tone],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
