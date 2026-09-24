'use client';

import { useState, type ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

// ─── Advanced: the list of programs, folded (#464) ────────────────────────────
//
// The checklist above is what an owner can judge. The free-text list of
// programs is for people who know what to write, so it sits folded under
// Advanced, and opens by default when a list is set: a restriction in force is
// never folded out of sight.

export default function AdvancedShellSection({
  defaultOpen,
  children,
}: {
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-3">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        inset="none"
        testId="shell-advanced"
      >
        <span className="text-medium-14 text-ink-2">Advanced: allowed programs</span>
      </DisclosureButton>
      {open && children}
    </div>
  );
}
