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
  /**
   * La CAPSULE, et non le bloc pleine largeur (planches de Quentin du
   * 19/09/2026, Figma 487:5489) : la tête du panneau met le titre à gauche et
   * l'espace à droite, sur UNE ligne. Le déclencheur devient une pastille —
   * point de couleur de 8 px, nom, caret — et la liste qu'il ouvre ne change
   * pas : même contenu, même « New workspace », simplement alignée à droite et
   * posée à une largeur qui la rend lisible.
   */
  compact?: boolean;
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
  compact = false,
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
    <div ref={ref} className={compact ? 'relative min-w-0' : 'relative mx-3.5 mt-3.5 mb-1'}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        data-testid={compact ? 'workspace-pill' : undefined}
        className={
          compact
            ? `flex max-w-full items-center gap-1.5 rounded-lg border border-rule-2 bg-paper py-1 pr-1.5 pl-2 text-medium-12 text-ink-2 ${
                disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover-2/40'
              }`
            : `flex h-12 w-full items-center gap-3 rounded-xl border border-rule-2 bg-paper px-3 text-body-15 leading-none! text-ink lg:h-[38px] lg:gap-2.5 lg:rounded-[9px] lg:px-2.5 lg:text-body-13 ${
                disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover-2/40'
              }`
        }
      >
        {compact ? (
          // Une PASTILLE de 8 px, et pas le carré à initiales : à cette taille
          // deux lettres ne se lisent plus, et la planche ne dessine qu'un
          // point. Il garde la couleur de l'espace, qui est ce qui le
          // distingue d'un coup d'œil.
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: active.color }}
            aria-hidden="true"
          />
        ) : (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-legacy-12 font-semibold leading-none! tracking-[0.04em] text-[#0a0a0a] lg:h-[22px] lg:w-[22px] lg:rounded-[5px] lg:text-micro-10"
            style={{ background: active.color }}
          >
            {active.icon ?? active.tag.slice(0, 2)}
          </span>
        )}
        {/* Le nom SE COUPE, il n'élargit pas la tête : un espace au long nom
            ferait déborder le titre du panneau, dont la largeur est fixe. */}
        <span
          className={
            compact
              ? 'min-w-0 truncate text-left'
              : 'min-w-0 flex-1 truncate text-left text-medium-15 text-ink lg:text-medium-13'
          }
        >
          {active.name}
        </span>
        {!disabled && (
          <CaretDown
            size={12}
            className={
              compact ? 'h-3 w-3 shrink-0 text-ink-3' : 'h-4 w-4 shrink-0 text-ink-3 lg:h-3 lg:w-3'
            }
          />
        )}
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          className={`absolute top-[calc(100%+6px)] z-30 rounded-[9px] border border-rule-2 bg-paper p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.10)] ${
            // La capsule est étroite : sa liste se pose à DROITE, sous elle, et
            // prend la largeur qu'il lui faut pour rester lisible.
            compact ? 'right-0 w-[220px] max-w-[80vw]' : 'inset-x-0'
          }`}
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
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 text-body-15 leading-[1.2]! text-ink-2 hover:bg-hover lg:gap-2.5 lg:rounded-md lg:px-2 lg:py-1.5 lg:text-body-13 ${
                  isActive ? 'bg-hover-2' : ''
                }`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-legacy-12 font-semibold leading-none! tracking-[0.04em] text-[#0a0a0a] lg:h-5 lg:w-5 lg:rounded-[5px] lg:text-micro-10"
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
              className="mt-1 flex w-full items-center gap-3 rounded-lg border-t border-rule px-2.5 py-2.5 text-medium-15 text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 lg:gap-2 lg:rounded-md lg:px-2 lg:py-1.5 lg:text-medium-12"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded text-legacy-16 leading-none! lg:h-4 lg:w-4 lg:text-body-12">
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
