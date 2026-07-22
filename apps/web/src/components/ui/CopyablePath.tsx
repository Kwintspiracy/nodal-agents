'use client';

import { toast } from 'sonner';
import { Copy } from '@phosphor-icons/react';

/**
 * CopyablePath — a one-line, layout-safe path display with a Copy button.
 * `display` is the short label shown (truncated if still long); `value` is the
 * full path copied to the clipboard. Optional `href` opens the folder.
 * Fixes long file paths that used to overflow onto one line and break the row.
 */
export default function CopyablePath({
  display,
  value,
  href,
}: {
  display: string;
  value: string;
  href?: string;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Path copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  const chip = (
    <span
      title={value}
      className="block truncate rounded-md bg-hover px-2 py-1 text-mono-13 text-ink-2"
    >
      {display}
    </span>
  );

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1">
        {href ? (
          <a href={href} title={value} className="block min-w-0 hover:opacity-80">
            {chip}
          </a>
        ) : (
          chip
        )}
      </span>
      <button
        type="button"
        onClick={copy}
        title="Copy full path"
        className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-md border border-rule-2 px-2.5 text-medium-12 text-ink-3 transition-colors hover:border-rule hover:text-ink"
      >
        <Copy size={13} /> Copy
      </button>
    </div>
  );
}
