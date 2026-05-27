/**
 * Banner — info/warn/tip notification strip used inside settings forms.
 * Replaces all inline info/warn boxes. Variants: `info` (blue), `warn` (coral).
 */

const IcInfo = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="w-4 h-4 flex-shrink-0 mt-0.5"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5v3M8 5.5h0" />
  </svg>
);

const IcWarn = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="w-4 h-4 flex-shrink-0 mt-0.5"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.5M8 10.5h0" />
  </svg>
);

export function Banner({
  variant,
  children,
}: {
  variant: 'info' | 'warn';
  children: React.ReactNode;
}) {
  const isInfo = variant === 'info';
  return (
    <div
      className={[
        'flex items-start gap-2.5 px-3.5 py-[11px] rounded-[9px] mt-1.5',
        'text-[12.5px] leading-[1.5] text-neutral-300',
        isInfo ? 'bg-blue-500/[0.06] text-blue-300/80' : 'bg-orange-500/[0.08] text-neutral-300',
      ].join(' ')}
    >
      <span className={isInfo ? 'text-blue-400' : 'text-orange-400'}>
        {isInfo ? IcInfo : IcWarn}
      </span>
      <span>{children}</span>
    </div>
  );
}
