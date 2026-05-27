'use client';

import { toast } from 'sonner';

/**
 * SetUrl — URL display block with optional Copy button.
 * Shows a subtitle label above the URL, and a copy button on the right.
 */
export function SetUrl({ subtitle, url }: { subtitle: string; url: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  return (
    <div className="flex items-center gap-3 bg-neutral-950/50 rounded-[9px] px-4 py-3.5 mt-2">
      <span className="flex-1 min-w-0">
        <span className="block text-xs leading-[1.4] text-neutral-500">{subtitle}</span>
        <span className="block font-mono text-[13px] leading-[1.4] text-white tracking-[0.02em] mt-1.5">
          {url}
        </span>
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border border-neutral-700 text-neutral-400 rounded-[7px] text-xs font-medium hover:border-neutral-600 hover:text-white transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-3.5 h-3.5"
        >
          <rect x="3" y="3" width="8" height="8" rx="1" />
          <rect x="5" y="5" width="8" height="8" rx="1" />
        </svg>
        Copy
      </button>
    </div>
  );
}
