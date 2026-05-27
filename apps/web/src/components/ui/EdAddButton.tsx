import type { ReactNode } from 'react';

type Props = {
  onClick?: () => void;
  href?: string;
  children: ReactNode;
  className?: string;
};

/**
 * EdAddButton — canonical `.ed-add` CTA. Full-width dashed-border button
 * used at the foot of an EdRow list ("Connect from marketplace", "Add
 * skill from marketplace", "Add knowledge source"…). Matches the handoff
 * styling at apps/web/design/inbound/nodalai/project/styles.css:669.
 *
 * Renders as an `<a>` when `href` is provided, otherwise a `<button>`.
 */
export default function EdAddButton({ onClick, href, children, className = '' }: Props) {
  const classes = `flex h-[42px] w-full items-center justify-center gap-2 rounded-[10px] border border-dashed border-rule bg-canvas/30 text-[13px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 ${className}`;
  const icon = (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M7 2v10M2 7h10" />
    </svg>
  );
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
