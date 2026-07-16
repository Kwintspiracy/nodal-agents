import type { ReactNode } from 'react';

type Size = 'md' | 'sm' | 'lg';

type Props = {
  onClick?: () => void;
  href?: string;
  children: ReactNode;
  /** Secondary, dimmer caption rendered after `children` — e.g. "group workers
   *  under a coordinator". Only meaningful with `size="lg"`. */
  hint?: ReactNode;
  size?: Size;
  className?: string;
};

const PLUS_SIZE: Record<Size, number> = { md: 14, sm: 11, lg: 14 };

/**
 * EdAddButton — canonical `.ed-add` CTA. Full-width dashed-border button
 * used at the foot of an EdRow list ("Connect from marketplace", "Add
 * skill from marketplace", "Add knowledge source"…). Matches the handoff
 * styling at apps/web/design/inbound/nodalai/project/styles.css:669.
 *
 * `size` (default `md`, unchanged from the original):
 *   - `sm` — compact variant for a worker-row footer inside an AgentsList
 *     card ("Add worker").
 *   - `lg` — card-sized variant with a boxed icon and an optional dimmer
 *     `hint` caption, used for AgentsList's "New orchestrator" footer.
 *
 * Renders as an `<a>` when `href` is provided, otherwise a `<button>`.
 */
export default function EdAddButton({
  onClick,
  href,
  children,
  hint,
  size = 'md',
  className = '',
}: Props) {
  const icon = (
    <svg
      width={PLUS_SIZE[size]}
      height={PLUS_SIZE[size]}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M7 2v10M2 7h10" />
    </svg>
  );

  if (size === 'lg') {
    const classes = `flex w-full items-center justify-center gap-3 rounded-2xl border border-dashed border-rule bg-paper/40 p-[17px] transition-colors hover:bg-paper/60 ${className}`;
    const content = (
      <>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-hover text-ink-3">
          {icon}
        </span>
        <span className="text-legacy-12-5 font-medium text-ink">{children}</span>
        {hint && <span className="text-legacy-11 text-ink-3">{hint}</span>}
      </>
    );
    if (href) {
      return (
        <a href={href} className={classes}>
          {content}
        </a>
      );
    }
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }

  const sizeClasses =
    size === 'sm'
      ? 'gap-[6px] rounded-[10px] py-[8.5px] text-legacy-11-5'
      : 'h-[42px] gap-2 rounded-[10px] text-medium-14';
  const classes = `flex w-full items-center justify-center border border-dashed border-rule bg-paper/40 font-medium text-ink-3 transition-colors hover:bg-paper/60 hover:text-ink-2 ${sizeClasses} ${className}`;

  if (href) {
    return (
      <a href={href} className={classes}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {icon}
      {children}
    </button>
  );
}
