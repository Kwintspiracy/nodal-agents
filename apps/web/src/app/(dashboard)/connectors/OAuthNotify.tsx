'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface Props {
  successLabel: string | null;
  /**
   * Errors are surfaced via a persistent banner rendered by the parent page,
   * not via this component. We still mirror the error to the console once
   * for DevTools traceability, but no toast and no URL strip — the user
   * dismisses the banner explicitly.
   */
  errorMessage: string | null;
}

/**
 * Fires a Sonner toast on success and strips ?just_connected / ?connected from the URL.
 * On error, OAuthNotify only logs to console — the persistent OAuthErrorBanner
 * (rendered by page.tsx when ?oauth_error is present) handles user-visible
 * error display, so the message survives navigation and refresh.
 */
export default function OAuthNotify({ successLabel, errorMessage }: Props) {
  const router = useRouter();
  // Guard against StrictMode double-fire.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    if (successLabel) {
      toast.success(`${successLabel} connected`);
      router.replace('/connectors');
    }
    if (errorMessage) {
      // Mirror to DevTools console for traceability; UI is handled by the banner.
      console.error('[OAuth] connection failed:', errorMessage);
    }
  }, [successLabel, errorMessage, router]);

  return null;
}
