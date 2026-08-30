'use client';

/**
 * OptionRadio — radio card matching the design's `.opt` pattern.
 * Active state: blue border + blue-tinted bg. Custom radio dot (no native <input>).
 *
 * Tokens are used throughout so the card respects the data-theme switch.
 */
export function OptionRadio({
  active,
  onClick,
  name,
  description,
  children,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  description: string;
  /** Rendered under the description — the mock puts a row of pills there. */
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={[
        'flex items-start gap-3.5 px-4 py-3.5 rounded-[10px] border cursor-pointer mb-2',
        'transition-[border-color,background-color] duration-[120ms]',
        active
          ? 'border-conn-vivid bg-conn-vivid/[0.06]'
          : 'border-rule-2 bg-paper hover:border-rule',
      ].join(' ')}
    >
      {/* Custom radio dot */}
      <span
        className={[
          'mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-[1.6px]',
          'flex items-center justify-center',
          active ? 'border-conn-vivid' : 'border-rule',
        ].join(' ')}
      >
        {active && <span className="w-2 h-2 rounded-full bg-conn-vivid" />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-medium-14 leading-[1.3]! text-ink">{name}</span>
        <span className="block text-body-13 leading-[1.4]! text-ink-3 mt-0.5">{description}</span>
        {children}
      </span>
    </div>
  );
}
