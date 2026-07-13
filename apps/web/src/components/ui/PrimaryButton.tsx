import Link from 'next/link';
import { forwardRef } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Variant = 'ink' | 'coral' | 'blue' | 'agent' | 'neutral' | 'danger';

// Create-button colour convention (matches the design): agents = lime,
// skills = coral, connectors/MCP = blue, EVERYTHING ELSE = white (neutral).
// `danger` is the one destructive-action variant (Disconnect/Delete in a
// modal's `ModalFooter` — see UX-B7): outlined in the error colour, at rest,
// so it doesn't out-shout the primary action next to it, matching
// RowActionButton's danger tone convention.
const VARIANT: Record<Variant, string> = {
  ink: 'bg-ink text-canvas border-0 hover:brightness-[0.92]',
  agent: 'bg-agent-vivid text-[#1a2200] border-0 hover:brightness-[0.96]',
  coral: 'bg-skill-vivid text-white border-0 hover:brightness-[0.94]',
  blue: 'bg-conn-vivid text-white border-0 hover:brightness-[0.94]',
  neutral: 'border border-rule-2 bg-paper text-ink hover:bg-hover',
  danger: 'border border-err/30 bg-paper text-err hover:border-err hover:bg-warn-bg',
};

type CommonProps = {
  children: ReactNode;
  variant?: Variant;
  /** `md` (default) matches the topbar `+ New agent` button at 34px tall. */
  size?: 'sm' | 'md';
  className?: string;
};

type AsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps | 'href'> & {
    href?: undefined;
  };

type AsLink = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps | 'href'> & {
    href: string;
  };

type Props = AsButton | AsLink;

/**
 * PrimaryButton — the dashboard's call-to-action surface. Used for "+ New
 * agent" in the topbar, "Save" in settings, "Install" on marketplace cards,
 * and so on. Every button inside a modal (ModalFooter, contextual action
 * rows) is a PrimaryButton — no bare `<button>`, no underlined text (UX-B7).
 *
 * Renders as a Next `<Link>` when `href` is provided, otherwise as a
 * `<button>`. That way the same atom covers both navigation CTAs and
 * form submits.
 *
 * Forwards its ref to the underlying `<button>`/`<Link>` (e.g. ConfirmDialog
 * focuses its Cancel button on open) — always an HTMLButtonElement for the
 * button flavour, HTMLAnchorElement for the link flavour.
 */
const PrimaryButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, Props>(
  function PrimaryButton(props, ref) {
    const { children, variant = 'ink', size = 'md', className = '' } = props;
    const dim = size === 'md' ? 'h-[34px] px-3.5 text-[14px]' : 'h-[30px] px-3 text-[13px]';
    const cls = `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium leading-none transition-[filter,background-color] ${dim} ${VARIANT[variant]} ${className}`;

    if ('href' in props && props.href) {
      // anchor-flavour
      const {
        href,
        variant: _v,
        size: _s,
        className: _c,
        children: _ch,
        ...rest
      } = props as AsLink;
      void _v;
      void _s;
      void _c;
      void _ch;
      return (
        <Link href={href} className={cls} ref={ref as Ref<HTMLAnchorElement>} {...rest}>
          {children}
        </Link>
      );
    }

    const { variant: _v, size: _s, className: _c, children: _ch, ...rest } = props as AsButton;
    void _v;
    void _s;
    void _c;
    void _ch;
    return (
      <button type="button" className={cls} ref={ref as Ref<HTMLButtonElement>} {...rest}>
        {children}
      </button>
    );
  },
);

export default PrimaryButton;
