/**
 * TagMini — uppercase mono mini-pill.
 * Variants: `ok` (lime-tinted), `warn` (coral-tinted), `info` (connector blue,
 * a fact found by Nodal), `neutral` (ink on hover grey, a plain label).
 * Smaller than StatusPill; used for status labels inside SetRow values, and for
 * the source of an allowed folder in the Sandbox section (#876).
 */
const VARIANT = {
  ok: 'bg-lime-400/20 text-lime-600 dark:text-lime-300',
  warn: 'bg-orange-500/[0.13] text-orange-700 dark:text-orange-400',
  info: 'bg-conn-vivid/10 text-conn-vivid',
  neutral: 'bg-hover text-ink-2',
} as const;

export function TagMini({
  variant,
  children,
}: {
  variant: keyof typeof VARIANT;
  children: React.ReactNode;
}) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[5px]',
        'font-mono text-label-11 tracking-[0.08em]',
        VARIANT[variant],
      ].join(' ')}
    >
      {children}
    </span>
  );
}
