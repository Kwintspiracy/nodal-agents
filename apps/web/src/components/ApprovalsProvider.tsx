'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ApprovalRow } from '@/lib/actions';
import { listApprovalsAction } from '@/lib/actions';

// Only the fields the bell / pill need — avoids exporting the full ApprovalRow
// to client bundles that don't need the rest.
export type PendingApproval = Pick<
  ApprovalRow,
  'id' | 'jobId' | 'toolName' | 'agentName' | 'toolInput' | 'requestedAt'
>;

type ApprovalsContextValue = {
  pending: PendingApproval[];
  refresh: () => void;
};

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

const POLL_INTERVAL_MS = 15_000;

export function ApprovalsProvider({
  initial,
  children,
}: {
  initial: PendingApproval[];
  children: ReactNode;
}) {
  const [pending, setPending] = useState<PendingApproval[]>(initial);

  const fetchPending = useCallback(async () => {
    const result = await listApprovalsAction({ status: 'pending' });
    if (!result.ok) return;
    // Map the full ApprovalRow down to the minimal PendingApproval shape.
    setPending(
      result.data.map((r) => ({
        id: r.id,
        jobId: r.jobId,
        toolName: r.toolName,
        agentName: r.agentName,
        toolInput: r.toolInput,
        requestedAt: r.requestedAt,
      })),
    );
  }, []);

  useEffect(() => {
    // Poll every 15 s, but skip while the tab is hidden.
    const id = setInterval(() => {
      if (!document.hidden) {
        void fetchPending();
      }
    }, POLL_INTERVAL_MS);

    // Re-poll immediately when the tab becomes visible again.
    function onVisibilityChange() {
      if (!document.hidden) {
        void fetchPending();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchPending]);

  const refresh = useCallback(() => {
    void fetchPending();
  }, [fetchPending]);

  return (
    <ApprovalsContext.Provider value={{ pending, refresh }}>{children}</ApprovalsContext.Provider>
  );
}

const FALLBACK: ApprovalsContextValue = { pending: [], refresh: () => {} };

export function useApprovals(): ApprovalsContextValue {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) {
    // Fail-soft: degrade to "no badge" rather than crashing the dashboard.
    // A wiring mistake should never surface as a raw error to the user.
    console.warn('[useApprovals] called outside <ApprovalsProvider> — returning empty state.');
    return FALLBACK;
  }
  return ctx;
}
