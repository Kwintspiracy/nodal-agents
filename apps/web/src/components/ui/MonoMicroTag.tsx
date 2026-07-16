/**
 * MonoMicroTag — rounded-full uppercase mono micro-badge (h-18).
 * Tones: `err` (coral), `skill` (lime), `warn` (amber), on a /10 tint of the tone.
 *
 * The inline flag that sits next to a setting label ("irreversible", "beta",
 * "experimental"). Distinct from TagMini (squared, semibold, sits inside SetRow
 * values) and StatusPill (larger state chip). Extracted from five identical
 * inline spans across AgentComposer and LanCommandYoloSection.
 */
type Tone = 'err' | 'skill' | 'warn';

const TONES: Record<Tone, string> = {
  err: 'bg-err/10 text-err',
  skill: 'bg-skill-vivid/10 text-skill-vivid',
  warn: 'bg-warn/10 text-warn',
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
