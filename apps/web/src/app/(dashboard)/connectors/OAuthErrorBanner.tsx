'use client';

import { useRouter } from 'next/navigation';
import { X } from '@phosphor-icons/react';
import RowActionButton from '@/components/ui/RowActionButton';

interface Props {
  /** OAuth error code (RFC 6749 + internal). */
  code: string;
  /** Resolved human-readable message including provider detail when available. */
  message: string;
}

/**
 * Persistent error banner rendered at the top of /connectors when an OAuth
 * flow ended in an error. Stays visible until the user clicks Dismiss —
 * unlike a toast it survives page navigation, refresh, and tab switch so
 * the user always has a chance to read the diagnostic.
 */
export default function OAuthErrorBanner({ code, message }: Props) {
  const router = useRouter();

  function dismiss() {
    router.replace('/connectors');
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-err/30 bg-warn-bg px-5 py-4 text-sm text-err"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="font-bold text-err">
              !
            </span>
            <p className="font-semibold text-err">OAuth connection failed</p>
            <code className="text-mono-11 text-err/80 bg-warn-bg px-1.5 py-0.5 rounded">
              {code}
            </code>
          </div>
          <p className="text-err leading-relaxed">{message}</p>
        </div>
        <div className="-mt-0.5 shrink-0">
          <RowActionButton
            square
            tone="danger"
            title="Dismiss"
            icon={<X size={14} />}
            onClick={dismiss}
          />
        </div>
      </div>
    </div>
  );
}
