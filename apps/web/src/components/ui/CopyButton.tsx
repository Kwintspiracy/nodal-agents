'use client';

import { toast } from 'sonner';
import { Copy } from '@phosphor-icons/react';

type Props = {
  /** Text copied to the clipboard on click. */
  value: string;
  /** Button label, next to the copy icon. */
  label?: string;
  successMessage?: string;
  errorMessage?: string;
  className?: string;
};

/**
 * CopyButton — icon+label button that copies `value` to the clipboard and
 * surfaces the result via the Sonner toaster. Canonical geometry: `h-[28px]
 * border-rule-2 bg-paper px-2.5 text-[12px]` — lifted from VersionBadge's
 * update-command row (first call site; promoted per DS Phase 2A so future
 * copy affordances — API keys, webhook URLs, code blocks — reuse it instead
 * of hand-rolling `navigator.clipboard` + toast at each call site).
 */
export default function CopyButton({
  value,
  label = 'Copy',
  successMessage = 'Copied',
  errorMessage = 'Could not copy',
  className = '',
}: Props) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error(errorMessage);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-2.5 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink ${className}`}
    >
      <Copy size={13} /> {label}
    </button>
  );
}
