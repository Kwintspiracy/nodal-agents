import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  /** When true a small coral dot is shown at the top-right of the button.
   *  Maps to `.icon-btn .badge` in the design bundle — used for the bell. */
  badge?: boolean;
  /** Visual size — `md` is the 34×34 topbar size; `sm` is 30×30 for in-row use. */
  size?: 'sm' | 'md';
  /** React 19 lets function components accept `ref` as a plain prop — no
   *  forwardRef needed. Used by Menu.tsx to measure the default trigger for
   *  panel positioning. */
  ref?: Ref<HTMLButtonElement>;
};

/**
 * IconButton — square paper-coloured button with a single icon child.
 * Used in the topbar (notifications, theme toggle) and inside table rows
 * (the `…` overflow button et al).
 */
export default function IconButton({
  children,
  badge,
  size = 'md',
  className = '',
  type = 'button',
  ref,
  ...rest
}: Props) {
  const dim = size === 'md' ? 'h-[34px] w-[34px] rounded-md' : 'h-[30px] w-[30px] rounded-[7px]';
  return (
    <button
      ref={ref}
      type={type}
      className={`relative flex shrink-0 items-center justify-center border border-rule-2 bg-paper text-ink-2 transition-colors hover:text-ink ${dim} ${className}`}
      {...rest}
    >
      {children}
      {badge && (
        <span className="absolute top-[6px] right-[7px] h-1.5 w-1.5 rounded-full bg-skill-vivid" />
      )}
    </button>
  );
}
