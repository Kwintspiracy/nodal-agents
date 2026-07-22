'use client';

import { useEffect } from 'react';

/**
 * Generic polling hook — extracted from ApprovalsProvider and
 * SkillUpdatesProvider, which were near-identical copies (interval + skip
 * while the tab is hidden + re-fetch on visibilitychange + cleanup).
 *
 * Fires `fetchFn` every `intervalMs`, skipping ticks while `document.hidden`
 * is true, and re-fetches immediately when the tab becomes visible again.
 * `immediate` (default false) additionally fires once on mount — both
 * current consumers pass false to keep their existing behavior (they seed
 * from server-rendered `initial` state instead of fetching on mount).
 */
export function usePolling(
  fetchFn: () => void | Promise<void>,
  intervalMs: number,
  immediate = false,
): void {
  useEffect(() => {
    if (immediate) {
      void fetchFn();
    }

    const id = setInterval(() => {
      if (!document.hidden) {
        void fetchFn();
      }
    }, intervalMs);

    function onVisibilityChange() {
      if (!document.hidden) {
        void fetchFn();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchFn, intervalMs, immediate]);
}
