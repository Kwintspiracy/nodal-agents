'use client';

// ChatFoldersProvider — ce que le menu « Chat folders » ne peut pas déduire des
// approbations (#135) : quels canaux portent des conversations, et où un run
// tourne en ce moment.
//
// Un provider À CÔTÉ d'`ApprovalsProvider` plutôt qu'un élargissement de
// celui-ci, pour la même raison que `SkillUpdatesProvider` : ce sont deux
// lectures différentes, avec deux sources différentes, et `ApprovalsProvider`
// a un consommateur (`NotificationsBell`) qui n'a que faire des dossiers. La
// cadence, elle, est la même — 15 s, le même `usePolling`.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { getChatFoldersAction, type ChatFoldersSnapshot } from '@/lib/conversation-actions.ts';
import { usePolling } from '@/lib/use-polling';

type ChatFoldersContextValue = ChatFoldersSnapshot;

const ChatFoldersContext = createContext<ChatFoldersContextValue | null>(null);

const POLL_INTERVAL_MS = 15_000;

export function ChatFoldersProvider({
  initial,
  children,
}: {
  initial: ChatFoldersSnapshot;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<ChatFoldersSnapshot>(initial);

  const fetchFolders = useCallback(async () => {
    const result = await getChatFoldersAction();
    // Une lecture en échec GARDE le dernier état connu plutôt que de vider le
    // menu : un canal qui disparaît puis revient à chaque hoquet de la base
    // déplacerait les lignes sous le curseur.
    if (!result.ok) return;
    setSnapshot(result.data);
  }, []);

  usePolling(fetchFolders, POLL_INTERVAL_MS);

  return <ChatFoldersContext.Provider value={snapshot}>{children}</ChatFoldersContext.Provider>;
}

const FALLBACK: ChatFoldersContextValue = {
  channels: [],
  running: {},
  runningConversationIds: [],
  externalRuns: 0,
  deliverablesToCheck: [],
  deliverableCheckJobIds: [],
  deliverableCheckConversationIds: [],
  runsInProgress: 0,
  workConversationsInProgress: 0,
};

export function useChatFolders(): ChatFoldersContextValue {
  const ctx = useContext(ChatFoldersContext);
  if (!ctx) {
    // Fail-soft, comme `useApprovals` : un câblage manquant se dégrade en
    // « aucun dossier de canal », jamais en écran blanc.
    console.warn('[useChatFolders] called outside <ChatFoldersProvider> — returning empty state.');
    return FALLBACK;
  }
  return ctx;
}
