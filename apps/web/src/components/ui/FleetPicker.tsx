'use client';

import { useEffect, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';

export type Fleet = {
  id: string;
  name: string;
  tag: string;
  /** Tailwind class or raw hex for the small badge. */
  color: string;
  /** Optional emoji shown in the badge instead of the 2-letter tag. */
  icon?: string;
  count?: number;
};

type Props = {
  fleets: Fleet[];
  activeId: string;
  /** When true, the dropdown is rendered but locked to the active fleet. */
  disabled?: boolean;
  onChange?: (id: string) => void;
  /** When provided, a "New workspace" button appears at the bottom of the dropdown. */
  onNewWorkspace?: () => void;
};

/**
 * FleetPicker — capsule at the top of the sidebar that lets a user switch
 * between fleets. Replaces the design bundle's `Quick command ⌘K` capsule
 * because NodalAI is a multi-fleet tool.
 *
 * Disabled mode keeps the visual present (one fleet shown, chevron rotated,
 * menu inert) until multi-fleet support actually ships in the DB.
 */
export default function FleetPicker({
  fleets,
  activeId,
  disabled,
  onChange,
  onNewWorkspace,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = fleets.find((f) => f.id === activeId) ?? fleets[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!active) return null;

  return (
    <div ref={ref} className="relative mx-3.5 mt-3.5 mb-1">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        className={`flex h-12 w-full items-center gap-3 rounded-xl border border-rule-2 bg-paper px-3 text-[15px] leading-none text-ink lg:h-[38px] lg:gap-2.5 lg:rounded-[9px] lg:px-2.5 lg:text-[13px] ${
          disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover-2/40'
        }`}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[12px] font-semibold leading-none tracking-[0.04em] text-[#0a0a0a] lg:h-[22px] lg:w-[22px] lg:rounded-[5px] lg:text-[10.5px]"
          style={{ background: active.color }}
        >
          {active.icon ?? active.tag.slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[15px] font-medium text-ink lg:text-[12.5px]">
          {active.name}
        </span>
        {!disabled && <CaretDown size={12} className="h-4 w-4 shrink-0 text-ink-3 lg:h-3 lg:w-3" />}
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          className="absolute inset-x-0 top-[calc(100%+6px)] z-30 rounded-[9px] border border-rule-2 bg-paper p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.10)]"
        >
          {fleets.map((f) => {
            const isActive = f.id === activeId;
            return (
              <div
                key={f.id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange?.(f.id);
                  setOpen(false);
                }}
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 text-[15px] leading-[1.2] text-ink-2 hover:bg-hover lg:gap-2.5 lg:rounded-md lg:px-2 lg:py-1.5 lg:text-[12.5px] ${
                  isActive ? 'bg-hover-2' : ''
                }`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[12px] font-semibold leading-none tracking-[0.04em] text-[#0a0a0a] lg:h-5 lg:w-5 lg:rounded-[5px] lg:text-[10px]"
                  style={{ background: f.color }}
                >
                  {f.icon ?? f.tag.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{f.name}</span>
                <Check
                  size={12}
                  weight="bold"
                  className={`h-4 w-4 text-ink lg:h-3 lg:w-3 ${isActive ? 'opacity-100' : 'opacity-0'}`}
                />
              </div>
            );
          })}
          {onNewWorkspace && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onNewWorkspace();
              }}
              className="mt-1 flex w-full items-center gap-3 rounded-lg border-t border-rule px-2.5 py-2.5 text-[15px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 lg:gap-2 lg:rounded-md lg:px-2 lg:py-1.5 lg:text-[12px]"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded text-[16px] leading-none lg:h-4 lg:w-4 lg:text-[12px]">
                +
              </span>
              New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
