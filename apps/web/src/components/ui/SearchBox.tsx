'use client';

import { MagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useRef, type FormEvent } from 'react';

type Props = {
  placeholder?: string;
  /** When set, a `/` keypress anywhere on the page focuses the input. Default true. */
  keyboardShortcut?: boolean;
  onSubmit?: (value: string) => void;
  /** Extra classes — used by the topbar to hide the field on mobile widths
   *  where there's no room (`hidden md:flex`). */
  className?: string;
};

/**
 * SearchBox — topbar search field with a small `/` kbd hint. Matches the
 * design bundle's `.home-tb .search` pattern.
 *
 * Intentionally uncontrolled — search wiring (debounced query, route, etc.)
 * lives at the page level. This component just owns the chrome and the
 * keyboard shortcut.
 */
export default function SearchBox({
  placeholder = 'Search agents, skills, runs…',
  keyboardShortcut = true,
  onSubmit,
  className = '',
}: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!keyboardShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const t = e.target as HTMLElement | null;
      // Don't hijack while the user is typing in an input/textarea elsewhere.
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyboardShortcut]);

  const handle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit?.(ref.current?.value ?? '');
  };

  return (
    <form
      onSubmit={handle}
      className={`flex h-[34px] min-w-[280px] items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-[13px] text-ink-4 ${className}`}
    >
      <MagnifyingGlass size={13} className="shrink-0" />
      <input
        ref={ref}
        type="search"
        placeholder={placeholder}
        className="flex-1 border-0 bg-transparent text-[14px] leading-none text-ink outline-none placeholder:text-ink-4"
      />
      <span className="rounded-[5px] border border-rule bg-black/5 px-1.5 py-[1px] font-mono text-[12px] leading-none text-ink-4 dark:bg-white/[0.06]">
        /
      </span>
    </form>
  );
}
