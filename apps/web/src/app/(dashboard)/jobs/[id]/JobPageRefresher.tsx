'use client';

// JobPageRefresher — minimal client component that calls router.refresh()
// on an interval while the job is live. This keeps the server-rendered
// timeline + status chip up-to-date without importing any rendering logic
// from the old JobStatusPoller.
//
// Stops refreshing once the job reaches a terminal status — the parent
// server component stops rendering this component when isLive is false.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 3000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export default function JobPageRefresher({ status }: { status: string }) {
  const router = useRouter();

  useEffect(() => {
    if (TERMINAL.has(status)) return;

    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [router, status]);

  return null;
}
