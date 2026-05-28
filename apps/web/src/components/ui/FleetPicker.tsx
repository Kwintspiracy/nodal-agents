'use client';

import { useEffect, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';

export type Fleet = {
  id: string;
  name: string;
  tag: string;
  /** Tailwind class or raw hex for the small badge. */
  color: string;
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
        className={`flex h-[38px] w-full items-center gap-2.5 rounded-[9px] border border-rule-2 bg-paper px-2.5 text-[13px] leading-none text-ink ${
          disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover-2/40'
        }`}
      >
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold leading-none tracking-[0.04em] text-[#0a0a0a]"
          style={{ background: active.color }}
        >
          {active.tag.slice(0, 2)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col text-left leading-[1.15]">
          <span className="truncate text-[12.5px] font-medium text-ink">{active.name}</span>
          <span className="mt-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] text-ink-4">
            {active.tag}
            {typeof active.count === 'number' && ` · ${active.count} agents`}
          </span>
        </span>
        {!disabled && <CaretDown size={12} className="shrink-0 text-ink-3" />}
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
                className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] leading-[1.2] text-ink-2 hover:bg-hover ${
                  isActive ? 'bg-hover-2' : ''
                }`}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[10px] font-semibold leading-none tracking-[0.04em] text-[#0a0a0a]"
                  style={{ background: f.color }}
                >
                  {f.tag.slice(0, 2)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                  <span className="font-medium text-ink">{f.name}</span>
                  <span className="font-mono text-[10px] leading-none tracking-[0.04em] text-ink-4">
                    {typeof f.count === 'number' ? `${f.count} agents · ` : ''}
                    {f.tag.toLowerCase()}
                  </span>
                </span>
                <Check
                  size={12}
                  weight="bold"
                  className={`text-ink ${isActive ? 'opacity-100' : 'opacity-0'}`}
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
              className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-rule px-2 py-1.5 text-[12px] font-medium text-ink-3 hover:bg-hover hover:text-ink-2 transition-colors"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded text-[12px] leading-none">
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
