import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  /** When true a small coral dot is shown at the top-right of the button.
   *  Maps to `.icon-btn .badge` in the design bundle — used for the bell. */
  badge?: boolean;
  /** Visual size — `md` is the 34×34 topbar size; `sm` is 30×30 for in-row
   *  use; `xs` is 28×28 for tight in-panel actions (chat). Ignored when
   *  `ghost` is set. */
  size?: 'xs' | 'sm' | 'md';
  /** Shape of the chrome square. `round` gives a full-circle button (chat send
   *  / new-conversation). Ignored when `ghost` is set. */
  shape?: 'square' | 'round';
  /** Surface treatment (ignored when `ghost`):
   *   - `chrome`  (default) — paper square + border, the topbar/table look
   *   - `subtle`  — filled `hover-2` tint, no border (chat send)
   *   - `ink`     — filled ink, canvas glyph, no border (chat new-conversation) */
  fill?: 'chrome' | 'subtle' | 'ink';
  /** Borderless, backgroundless variant — for an icon control embedded inside
   *  another surface (the show/hide toggle inside a password field, the
   *  sidebar's mobile hamburger/close, the user-menu sign-out icon) where the
   *  usual chrome square would visually clash. `size`/`shape`/`fill` are ignored
   *  in this mode — the caller sizes it directly via `className`. */
  ghost?: boolean;
  /** React 19 lets function components accept `ref` as a plain prop — no
   *  forwardRef needed. Used by Menu.tsx to measure the default trigger for
   *  panel positioning. */
  ref?: Ref<HTMLButtonElement>;
};

const DIM: Record<NonNullable<Props['size']>, string> = {
  xs: 'h-7 w-7',
  sm: 'h-[30px] w-[30px]',
  md: 'h-[34px] w-[34px]',
};

const FILL: Record<NonNullable<Props['fill']>, string> = {
  chrome: 'border border-rule-2 bg-paper text-ink-2 hover:text-ink',
  subtle: 'bg-hover-2 text-ink-2 hover:bg-hover',
  ink: 'bg-ink text-canvas hover:brightness-[0.92]',
};

/**
 * IconButton — square (or round) button with a single icon child.
 * Used in the topbar (notifications, theme toggle), inside table rows (the `…`
 * overflow button et al) and the chat composer (round send / new-conversation).
 */
export default function IconButton({
  children,
  badge,
  size = 'md',
  shape = 'square',
  fill = 'chrome',
  ghost = false,
  className = '',
  type = 'button',
  ref,
  ...rest
}: Props) {
  const radius =
    shape === 'round' ? 'rounded-full' : size === 'md' ? 'rounded-md' : 'rounded-[7px]';
  const chrome = ghost ? 'text-ink-2 hover:text-ink' : `${DIM[size]} ${radius} ${FILL[fill]}`;

  return (
    <button
      ref={ref}
      type={type}
      className={`relative flex shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${chrome} ${className}`}
      {...rest}
    >
      {children}
      {badge && (
        <span className="absolute top-[6px] right-[7px] h-1.5 w-1.5 rounded-full bg-skill-vivid" />
      )}
    </button>
  );
}
