'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface Props {
  successLabel: string | null;
  errorMessage: string | null;
}

/**
 * Fires Sonner toasts on mount when OAuth redirect lands with
 * ?connected= or ?oauth_error= search params, then strips params from the URL.
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
    }
    if (errorMessage) {
      toast.error(errorMessage);
    }

    // Strip ?connected / ?oauth_error from the URL so a refresh doesn't re-fire.
    if (successLabel || errorMessage) {
      router.replace('/connectors');
    }
  }, [successLabel, errorMessage, router]);

  return null;
}
