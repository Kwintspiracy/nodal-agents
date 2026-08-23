'use client';

import { toast } from 'sonner';

/**
 * SetUrl — URL display block with optional Copy button.
 * Shows a subtitle label above the URL, and a copy button on the right.
 */
export function SetUrl({ subtitle, url }: { subtitle: string; url: string }) {
  async function copy() {
    // navigator.clipboard n'existe qu'en contexte sécurisé — or le dashboard
    // se sert AUSSI en http sur une IP LAN (bind=lan), où le bouton Copy est
    // l'affordance principale. Repli execCommand pour ce cas.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        legacyCopy(url);
      }
      toast.success('Copied');
    } catch {
      try {
        legacyCopy(url);
        toast.success('Copied');
      } catch {
        toast.error('Could not copy');
      }
    }
  }

  function legacyCopy(text: string) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy_failed');
  }

  return (
    <div className="flex items-center gap-3 bg-canvas/40 border border-rule-2 rounded-[9px] px-4 py-3.5 mt-2">
      <span className="flex-1 min-w-0">
        <span className="block text-xs leading-[1.4] text-ink-4">{subtitle}</span>
        {/* break-all: a URL is one unbroken token — without it the mono line
            can't wrap and overflows the modal (webhook-created panel). */}
        <span className="block font-mono text-legacy-14 leading-[1.4]! text-ink tracking-[0.02em] mt-1.5 break-all">
          {url}
        </span>
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border border-rule text-ink-3 rounded-[7px] text-xs font-medium hover:border-rule-2 hover:text-ink transition-colors"
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
