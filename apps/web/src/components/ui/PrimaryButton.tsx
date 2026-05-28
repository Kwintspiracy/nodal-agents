import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'ink' | 'coral' | 'blue';

const VARIANT: Record<Variant, string> = {
  ink: 'bg-ink text-canvas hover:brightness-[0.92]',
  coral: 'bg-skill-vivid text-white hover:brightness-[0.94]',
  blue: 'bg-conn-vivid text-white hover:brightness-[0.94]',
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
  const dim = size === 'md' ? 'h-[34px] px-3.5 text-[13px]' : 'h-[30px] px-3 text-[12px]';
  const cls = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium leading-none border-0 cursor-pointer transition-[filter] ${dim} ${VARIANT[variant]} ${className}`;

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
