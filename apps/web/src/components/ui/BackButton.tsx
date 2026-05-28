'use client';

import { useRouter } from 'next/navigation';
import { CaretLeft } from '@phosphor-icons/react';

type Props = {
  /** Explicit href to navigate to. When omitted, falls back to router.back(). */
  href?: string;
  /** Label after the chevron. Defaults to "Back". */
  label?: string;
  className?: string;
};

/**
 * BackButton — small ghost button used on detail pages. Maps to `.ad-back`
 * in the design bundle (Agent detail, future Run detail).
 *
 * Default behaviour navigates the browser back stack; pass `href` for a
 * deterministic destination (preferred when the user might land directly
 * on the detail page without a referrer).
 */
export default function BackButton({ href, label = 'Back', className = '' }: Props) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (href ? router.push(href) : router.back())}
      className={`inline-flex items-center gap-1.5 border-0 bg-transparent py-2 text-[13px] font-medium leading-none text-ink-3 transition-colors hover:text-ink ${className}`}
    >
      <CaretLeft size={14} weight="bold" />
      {label}
    </button>
  );
}
