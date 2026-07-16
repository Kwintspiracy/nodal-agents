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
import { ModalFooter } from '@/components/ui/Modal.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import IconTextButton from '@/components/ui/IconTextButton.tsx';
import SelectableTile from '@/components/ui/SelectableTile.tsx';

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
      {label && <label className="block text-xs text-ink-3 mb-1">{label}</label>}
      <IconTextButton
        onClick={() => setOpen(true)}
        className="group max-w-xs gap-3 rounded-md border border-rule bg-hover px-3 py-2 hover:border-rule"
        icon={<AvatarPreview url={value} size={36} />}
        title={value ? value.split('/').pop()?.replace('.png', '') : 'No avatar'}
        titleClassName="text-sm text-ink"
        subtitle={`Click to ${value ? 'change' : 'pick'}`}
        subtitleClassName="text-body-12 text-ink-3"
      />

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
              className="bg-paper border border-rule-2 rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            >
              <div className="p-5 pb-4">
                <h3 className="text-sm font-semibold text-ink mb-4">Pick an avatar</h3>

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
              <ModalFooter className="rounded-b-2xl">
                <PrimaryButton variant="neutral" onClick={() => setOpen(false)}>
                  Close
                </PrimaryButton>
              </ModalFooter>
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
        className="rounded-full object-cover border border-rule shrink-0"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full bg-hover border border-dashed border-rule text-ink-3 text-xs flex items-center justify-center shrink-0"
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
    <SelectableTile selected={selected} onClick={onClick} label={label}>
      <AvatarPreview url={url} size={56} />
    </SelectableTile>
  );
}
