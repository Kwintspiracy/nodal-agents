import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'ink' | 'coral' | 'blue' | 'agent' | 'neutral';

// Create-button colour convention (matches the design): agents = lime,
// skills = coral, connectors/MCP = blue, EVERYTHING ELSE = white (neutral).
const VARIANT: Record<Variant, string> = {
  ink: 'bg-ink text-canvas border-0 hover:brightness-[0.92]',
  agent: 'bg-agent-vivid text-[#1a2200] border-0 hover:brightness-[0.96]',
  coral: 'bg-skill-vivid text-white border-0 hover:brightness-[0.94]',
  blue: 'bg-conn-vivid text-white border-0 hover:brightness-[0.94]',
  neutral: 'border border-rule-2 bg-paper text-ink hover:bg-hover',
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
 * and so on.
 *
 * Renders as a Next `<Link>` when `href` is provided, otherwise as a
 * `<button>`. That way the same atom covers both navigation CTAs and
 * form submits.
 */
export default function PrimaryButton(props: Props) {
  const { children, variant = 'ink', size = 'md', className = '' } = props;
  const dim = size === 'md' ? 'h-[34px] px-3.5 text-[14px]' : 'h-[30px] px-3 text-[13px]';
  const cls = `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium leading-none transition-[filter,background-color] ${dim} ${VARIANT[variant]} ${className}`;

  if ('href' in props && props.href) {
    // anchor-flavour
    const { href, variant: _v, size: _s, className: _c, children: _ch, ...rest } = props as AsLink;
    void _v;
    void _s;
    void _c;
    void _ch;
    return (
      <Link href={href} className={cls} {...rest}>
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
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
