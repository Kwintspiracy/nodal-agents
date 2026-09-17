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
// Et on ne reste pas les bras croisés pendant qu'il réfléchit (Quentin, même
// jour) : la saisie reste ouverte, chaque message envoyé s'ajoute au fil, et le
// runner les traite dans l'ordre, un tour à la fois par conversation.
//
// Le runner écrit le tour de l'utilisateur AVANT d'appeler le modèle
// (`run-chat-turn.ts`, 1b), mais l'action serveur n'en revient qu'avec la
// réponse, et le fil — rendu côté serveur — ne se relit qu'après. Ce composant
// comble ce temps-là, côté client, avec ce qu'on SAIT déjà : les textes
// envoyés, et le fait qu'on attend.
//
// Il ne devine rien de plus : pas de réponse partielle, pas de durée. Et
// chaque copie s'efface D'ELLE-MÊME dès que le fil rendu par le serveur porte
// son texte (`requests`) : c'est le fil qui fait foi, jamais cette copie.

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { originLabel } from '@/app/(dashboard)/spaces/format.ts';

type Pending = {
  id: number;
  /** Le texte envoyé, tel quel. */
  text: string;
  /** Combien de fois ce texte était DÉJÀ dans le fil (rendu ou en attente)
   *  au moment de l'envoi : la copie s'efface quand le fil en porte un de
   *  plus. Deux « ok » de suite s'effacent donc l'un après l'autre. */
  baseline: number;
};

type Store = {
  /** Les messages partis que le serveur n'a pas encore rendus, dans l'ordre. */
  pending: readonly Pending[];
  begin: (text: string) => number;
  end: (id: number) => void;
};

const NOOP: Store = { pending: [], begin: () => 0, end: () => {} };
const PendingTurnContext = createContext<Store>(NOOP);

function countOf(texts: readonly string[], text: string): number {
  let n = 0;
  for (const t of texts) if (t === text) n++;
  return n;
}

/** Ce qui reste à montrer : les copies dont le fil ne porte pas encore le texte. */
export function stillPending(pending: readonly Pending[], requests: readonly string[]): Pending[] {
  return pending.filter((p) => countOf(requests, p.text) <= p.baseline);
}

/** Le porteur de l'état « des messages sont partis » — un par écran de fil. */
export function PendingTurnProvider({
  requests,
  children,
}: {
  /** Les demandes que le serveur a rendues, dans l'ordre du fil. */
  requests: readonly string[];
  children: ReactNode;
}) {
  const [all, setAll] = useState<readonly Pending[]>([]);
  const nextId = useRef(0);
  // Une dérivation, pas un effet : rien à synchroniser, rien à oublier.
  const pending = stillPending(all, requests);
  const store: Store = {
    pending,
    begin: (text) => {
      const id = ++nextId.current;
      const baseline =
        countOf(requests, text) +
        countOf(
          pending.map((p) => p.text),
          text,
        );
      // On range en passant ce que le fil a déjà rendu.
      setAll((prev) => [...stillPending(prev, requests), { id, text, baseline }]);
      return id;
    },
    end: (id) => setAll((prev) => prev.filter((p) => p.id !== id)),
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
  const { pending } = usePendingTurn();
  if (pending.length === 0) return null;

  return (
    <div className="mx-auto max-w-[760px]" data-testid="pending-turn" aria-live="polite">
      {/* Les messages qui viennent de partir, à droite, comme ils seront rendus. */}
      {pending.map((p) => (
        <div key={p.id} className="flex justify-end pt-6" data-testid="pending-message">
          <div className="max-w-[80%] min-w-0">
            <p className="mb-1.5 text-right text-mono-11 text-ink-4">
              {originLabel({ channel: 'dashboard', scheduleName: null, chatId: null })}
            </p>
            <div className="rounded-xl bg-hover px-4 py-3">
              <p className="max-w-[68ch] text-body-15 whitespace-pre-wrap text-ink">{p.text}</p>
            </div>
          </div>
        </div>
      ))}
      {/* L'agent, à gauche, qui réfléchit — l'en-tête de tour, et à la place
          de sa réponse trois points qui battent. Une seule fois, même quand
          plusieurs messages attendent : il les prend dans l'ordre. */}
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
