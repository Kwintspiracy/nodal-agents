'use client';

// use-device-pairings-count.ts — how many pairing requests wait (#946): the
// coral pill on "Devices" in the Settings panel.
//
// Read at the sidebar's own pace (`SIDEBAR_POLL_MS`), like the approvals pill.
// A read that fails keeps the last count it had rather than inventing zero: a
// pill that vanished because the runner did not answer would say "nothing
// waits", which nobody checked.

import { useCallback, useEffect, useState } from 'react';
import { countPendingPairingsAction } from '@/lib/device-actions.ts';
import { SIDEBAR_POLL_MS, usePolling } from '@/lib/use-polling.ts';

/**
 * Settings → Devices reads the requests every few seconds, and after each
 * gesture (confirm, refuse): it says the count it just read through this
 * event, so the pill never shows a request the page already took away.
 */
export const DEVICE_PAIRINGS_COUNT_EVENT = 'nodal:device-pairings-count';

export function announceDevicePairingsCount(count: number): void {
  window.dispatchEvent(new CustomEvent<number>(DEVICE_PAIRINGS_COUNT_EVENT, { detail: count }));
}

export function useDevicePairingsCount(): number {
  const [count, setCount] = useState(0);
  const read = useCallback(async () => {
    try {
      const res = await countPendingPairingsAction();
      if (res.ok) setCount(res.data);
    } catch {
      // Kept as it was: see the header.
    }
  }, []);
  usePolling(read, SIDEBAR_POLL_MS, true);
  useEffect(() => {
    const heard = (e: Event) => setCount((e as CustomEvent<number>).detail);
    window.addEventListener(DEVICE_PAIRINGS_COUNT_EVENT, heard);
    return () => window.removeEventListener(DEVICE_PAIRINGS_COUNT_EVENT, heard);
  }, []);
  return count;
}
