/**
 * TagMini — uppercase mono mini-pill.
 * Variants: `ok` (lime-tinted), `warn` (coral-tinted).
 * Smaller than StatusPill; used for status labels inside SetRow values.
 */
export function TagMini({
  variant,
  children,
}: {
  variant: 'ok' | 'warn';
  children: React.ReactNode;
}) {
  const cls =
    variant === 'ok'
      ? 'bg-lime-400/20 text-lime-600 dark:text-lime-300'
      : 'bg-orange-500/[0.13] text-orange-700 dark:text-orange-400';

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[5px]',
        'font-mono font-semibold text-[11px] tracking-[0.08em]',
        cls,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
