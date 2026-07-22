'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { SkillUpdateNotice } from '@/lib/actions';
import { listSkillUpdatesAction } from '@/lib/actions';
import { usePolling } from '@/lib/use-polling';

export type { SkillUpdateNotice };

type SkillUpdatesContextValue = {
  updates: SkillUpdateNotice[];
  refresh: () => void;
};

const SkillUpdatesContext = createContext<SkillUpdatesContextValue | null>(null);

const POLL_INTERVAL_MS = 15_000;

/**
 * SkillUpdatesProvider — sibling to ApprovalsProvider (same poll cadence,
 * same hidden-tab skip), for the second source the bell watches: community
 * skills with a pending update. Kept as its own context instead of folding
 * into ApprovalsProvider — approvals and skill updates are different
 * domains with different action-result shapes, and the bell just merges
 * both counts.
 */
export function SkillUpdatesProvider({
  initial,
  children,
}: {
  initial: SkillUpdateNotice[];
  children: ReactNode;
}) {
  const [updates, setUpdates] = useState<SkillUpdateNotice[]>(initial);

  const fetchUpdates = useCallback(async () => {
    const result = await listSkillUpdatesAction();
    if (!result.ok) return;
    setUpdates(result.data);
  }, []);

  usePolling(fetchUpdates, POLL_INTERVAL_MS);

  const refresh = useCallback(() => {
    void fetchUpdates();
  }, [fetchUpdates]);

  return (
    <SkillUpdatesContext.Provider value={{ updates, refresh }}>
      {children}
    </SkillUpdatesContext.Provider>
  );
}

const FALLBACK: SkillUpdatesContextValue = { updates: [], refresh: () => {} };

export function useSkillUpdates(): SkillUpdatesContextValue {
  const ctx = useContext(SkillUpdatesContext);
  if (!ctx) {
    // Fail-soft, same rationale as useApprovals: a wiring mistake should
    // degrade to "no badge", not crash the dashboard.
    console.warn(
      '[useSkillUpdates] called outside <SkillUpdatesProvider> — returning empty state.',
    );
    return FALLBACK;
  }
  return ctx;
}
