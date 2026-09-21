'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { ApprovalRow } from '@/lib/actions';
import { listApprovalsAction } from '@/lib/actions';
import { usePolling } from '@/lib/use-polling';

// Only the fields the bell / pill need — avoids exporting the full ApprovalRow
// to client bundles that don't need the rest.
export type PendingApproval = Pick<
  ApprovalRow,
  | 'id'
  | 'jobId'
  | 'toolName'
  | 'agentName'
  | 'toolInput'
  | 'requestedAt'
  | 'jobChannel'
  | 'conversationChannel'
>;

type ApprovalsContextValue = {
  pending: PendingApproval[];
  /**
   * RELIRE LES ATTENTES TOUT DE SUITE, sans attendre le tour de cadence.
   *
   * Elle rend une promesse, et ce n'est pas un détail : celui qui vient de
   * répondre à une demande l'attend avant de rendre la main, si bien que la
   * pastille du rail est déjà tombée quand le bouton se réactive. Sans elle,
   * la barre garderait le vieux nombre pendant quinze secondes, et la personne
   * lirait « 1 pending » après avoir répondu à la dernière demande.
   */
  refresh: () => Promise<void>;
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
    // Une lecture qui LÈVE est attrapée ici, et pas plus loin : `refresh` est
    // attendue par celui qui vient de répondre, et un rejet remonterait dans sa
    // transition, où personne ne l'attrape — il perdrait son toast de succès
    // pour une décision pourtant enregistrée. Attrapée, elle garde le dernier
    // état connu et le DIT dans la console (jamais en silence).
    let result: Awaited<ReturnType<typeof listApprovalsAction>>;
    try {
      result = await listApprovalsAction({ status: 'pending' });
    } catch (err) {
      console.error('[ApprovalsProvider] listApprovalsAction threw', err);
      return;
    }
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
        // D'OÙ vient la demande. Le menu Chat range chaque attente dans son
        // dossier avec ces deux champs (#135, #148) — le canal de sa
        // conversation d'abord, celui de son job quand elle n'en a pas. La
        // pastille d'un dossier est exactement le nombre de lignes qui le
        // désignent.
        jobChannel: r.jobChannel,
        conversationChannel: r.conversationChannel,
      })),
    );
  }, []);

  usePolling(fetchPending, POLL_INTERVAL_MS);

  const refresh = useCallback(async () => {
    await fetchPending();
  }, [fetchPending]);

  return (
    <ApprovalsContext.Provider value={{ pending, refresh }}>{children}</ApprovalsContext.Provider>
  );
}

const FALLBACK: ApprovalsContextValue = { pending: [], refresh: async () => {} };

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
