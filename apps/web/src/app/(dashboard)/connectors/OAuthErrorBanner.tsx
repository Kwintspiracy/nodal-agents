'use client';

import { useRouter } from 'next/navigation';
import { X } from '@phosphor-icons/react';
import Banner from '@/components/ui/Banner';
import MonoCode from '@/components/ui/MonoCode';
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
    <Banner
      variant="warn"
      role="alert"
      title="OAuth connection failed"
      action={
        <RowActionButton
          square
          tone="danger"
          title="Dismiss"
          icon={<X size={14} />}
          onClick={dismiss}
        />
      }
    >
      <p>{message}</p>
      <MonoCode className="mt-1.5">{code}</MonoCode>
    </Banner>
  );
}
