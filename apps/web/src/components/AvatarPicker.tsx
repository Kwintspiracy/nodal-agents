'use client';

// AvatarPicker — controlled input that lets the user pick an avatar from
// the bundled gallery (apps/web/public/avatars/avatar-{01..42}.png).
//
// API:
//   - `value`: current avatar URL or null
//   - `onChange(url | null)`: called when the user picks one or clears
//
// Rendering:
//   - The trigger button shows the current avatar (or a "?" placeholder).
//   - Click → portal-rendered modal with a 6×7 grid + a "None" cell.
//   - Click a tile → onChange + close. Backdrop / Esc → cancel.
//
// We render via `createPortal` to <body> so the modal escapes any
// `overflow: hidden` ancestor on the form. Same pattern as ConfirmDialog.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AVATAR_CATALOG } from '@/lib/avatar-catalog.ts';

interface Props {
  value: string | null;
  onChange: (url: string | null) => void;
  /** Optional label shown above the trigger — defaults to "Avatar". */
  label?: string;
}

export default function AvatarPicker({ value, onChange, label = 'Avatar' }: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function pick(url: string | null) {
    onChange(url);
    setOpen(false);
  }

  return (
    <div>
      {label && <label className="block text-xs text-neutral-500 mb-1">{label}</label>}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex items-center gap-3 bg-neutral-800 border border-neutral-700 hover:border-neutral-600 rounded-md px-3 py-2 text-left transition-colors w-full max-w-xs"
      >
        <AvatarPreview url={value} size={36} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">
            {value ? value.split('/').pop()?.replace('.png', '') : 'No avatar'}
          </p>
          <p className="text-[11px] text-neutral-500">Click to {value ? 'change' : 'pick'}</p>
        </div>
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pick an avatar"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Pick an avatar</h3>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-neutral-500 hover:text-white text-xs"
                >
                  Close (Esc)
                </button>
              </div>

              <div className="grid grid-cols-6 gap-3">
                {/* "None" cell — clears the avatar. First so the user sees it. */}
                <PickerTile
                  selected={value === null}
                  onClick={() => pick(null)}
                  label="None"
                  url={null}
                />
                {AVATAR_CATALOG.map((a) => (
                  <PickerTile
                    key={a.id}
                    selected={value === a.url}
                    onClick={() => pick(a.url)}
                    label={a.id}
                    url={a.url}
                  />
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function AvatarPreview({ url, size = 32 }: { url: string | null; size?: number }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="rounded-full object-cover border border-neutral-700 shrink-0"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full bg-neutral-800 border border-dashed border-neutral-700 text-neutral-500 text-xs flex items-center justify-center shrink-0"
    >
      ?
    </div>
  );
}

function PickerTile({
  selected,
  onClick,
  label,
  url,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  url: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      className={`aspect-square rounded-lg p-1 flex items-center justify-center transition-all ${
        selected
          ? 'bg-white/10 ring-2 ring-emerald-400'
          : 'bg-neutral-800/40 hover:bg-neutral-800 ring-1 ring-transparent hover:ring-neutral-700'
      }`}
    >
      <AvatarPreview url={url} size={56} />
    </button>
  );
}
