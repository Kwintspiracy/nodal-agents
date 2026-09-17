'use client';

// PendingTurn — ce que le fil montre ENTRE l'envoi et la réponse.
//
// Avant : on cliquait Envoyer, le bouton disait « Sending… », et RIEN ne
// changeait dans le fil jusqu'au retour du modèle — les deux messages
// apparaissaient d'un coup. Quentin, 18/09/2026 : « ça ne fonctionne comme ça
// dans aucun LLM existant ». Ce qu'on attend, en deux temps : le message part
// et apparaît TOUT DE SUITE dans le fil ; l'agent apparaît à gauche avec une
// petite animation qui dit qu'il réfléchit ; la réponse la remplace dès qu'elle
// arrive.
//
// Le runner écrit le tour de l'utilisateur AVANT d'appeler le modèle
// (`run-chat-turn.ts`, 1b), mais l'action serveur n'en revient qu'avec la
// réponse, et le fil — rendu côté serveur — ne se relit qu'après. Ce composant
// comble ce temps-là, côté client, avec ce qu'on SAIT déjà : le texte envoyé,
// et le fait qu'on attend.
//
// Il ne devine rien de plus : pas de réponse partielle, pas de durée. Et il
// s'efface DE LUI-MÊME dès que le fil rendu par le serveur a changé
// (`signature`) : c'est le fil qui fait foi, jamais cette copie.

import { createContext, useContext, useState, type ReactNode } from 'react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { originLabel } from '@/app/(dashboard)/spaces/format.ts';

type Pending = {
  /** Le texte envoyé, tel quel. */
  text: string;
  /** La signature du fil rendu AU MOMENT de l'envoi : tant qu'elle ne change
   *  pas, le serveur n'a pas encore rendu le nouveau tour. */
  signature: string;
};

type Store = {
  pending: Pending | null;
  /** La signature du fil TEL QUE le serveur vient de le rendre. */
  signature: string;
  begin: (text: string) => void;
  end: () => void;
};

const NOOP: Store = { pending: null, signature: '', begin: () => {}, end: () => {} };
const PendingTurnContext = createContext<Store>(NOOP);

/** Le porteur de l'état « un message est parti » — un par écran de fil. */
export function PendingTurnProvider({
  signature,
  children,
}: {
  /** La signature du fil rendu par le serveur — elle change à chaque relecture
   *  qui apporte une ligne de plus. */
  signature: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const store: Store = {
    pending,
    signature,
    begin: (text) => setPending({ text, signature }),
    end: () => setPending(null),
  };
  return <PendingTurnContext.Provider value={store}>{children}</PendingTurnContext.Provider>;
}

/** Sans porteur (un test qui monte la saisie seule), les gestes ne font rien. */
export function usePendingTurn(): Store {
  return useContext(PendingTurnContext);
}

export default function PendingTurn({
  agentName,
  agentAvatarUrl = null,
}: {
  agentName: string;
  agentAvatarUrl?: string | null;
}) {
  const { pending, signature } = usePendingTurn();
  // Le serveur a rendu autre chose depuis l'envoi : la copie a fait son temps.
  // Une dérivation, pas un effet : rien à synchroniser, rien à oublier.
  if (pending === null || pending.signature !== signature) return null;

  return (
    <div className="mx-auto max-w-[760px]" data-testid="pending-turn" aria-live="polite">
      {/* Le message qui vient de partir, à droite, comme il sera rendu. */}
      <div className="flex justify-end pt-6">
        <div className="max-w-[80%] min-w-0">
          <p className="mb-1.5 text-right text-mono-11 text-ink-4">
            {originLabel({ channel: 'dashboard', scheduleName: null, chatId: null })}
          </p>
          <div className="rounded-xl bg-hover px-4 py-3">
            <p className="max-w-[68ch] text-body-15 whitespace-pre-wrap text-ink">{pending.text}</p>
          </div>
        </div>
      </div>
      {/* L'agent, à gauche, qui réfléchit — l'en-tête de tour, et à la place
          de sa réponse trois points qui battent. */}
      <div className="min-w-0 pt-6">
        <div className="mb-1.5 flex items-center gap-2.5">
          <AgentAvatar name={agentName} imageUrl={agentAvatarUrl} size="sm" shape="square" />
          <span className="text-title-15 text-ink">{agentName}</span>
        </div>
        <div className="flex items-center gap-2 text-mono-11 text-feed-reasoning">
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning [animation-delay:300ms]" />
          </span>
          <span>thinking</span>
        </div>
      </div>
    </div>
  );
}
