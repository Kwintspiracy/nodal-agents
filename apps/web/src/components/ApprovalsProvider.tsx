'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { listApprovalsAction } from '@/lib/actions';
import { usePolling } from '@/lib/use-polling';
import { toPendingApproval, type PendingApproval } from '@/lib/pending-approval.ts';

// Only the fields the bell / pill need — avoids exporting the full ApprovalRow
// to client bundles that don't need the rest.
export type { PendingApproval };

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
    // TOUTE LA LECTURE est sous le garde — l'appel ET le traitement de sa
    // réponse (Reviewer C, passe 2 : n'envelopper que l'appel ne couvrait que
    // la moitié du chemin, et une `data` qui n'est pas un tableau faisait lever
    // le `.map`).
    //
    // La raison du garde : `refresh` est attendue par celui qui vient de
    // répondre, et un rejet remonterait dans sa transition, où personne ne
    // l'attrape — son bouton resterait désactivé et il perdrait le toast de
    // succès d'une décision pourtant enregistrée. Attrapée, la lecture garde le
    // dernier état connu et le DIT dans la console (jamais en silence).
    try {
      const result = await listApprovalsAction({ status: 'pending' });
      if (!result.ok) return;
      // Map the full ApprovalRow down to the minimal PendingApproval shape.
      setPending(result.data.map(toPendingApproval));
    } catch (err) {
      console.error('[ApprovalsProvider] reading the pending approvals failed', err);
    }
  }, []);

  usePolling(fetchPending, POLL_INTERVAL_MS);

  const refresh = useCallback(async () => {
    await fetchPending();
  }, [fetchPending]);

  // Un objet neuf à chaque rendu ferait re-rendre TOUS les consommateurs — la
  // barre, la cloche, la surface de décision — à chaque rendu du parent, alors
  // que rien n'a changé pour eux (Reviewer C, passe 4).
  const valeur = useMemo(() => ({ pending, refresh }), [pending, refresh]);

  return <ApprovalsContext.Provider value={valeur}>{children}</ApprovalsContext.Provider>;
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
