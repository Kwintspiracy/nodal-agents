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
// runner les traite dans l'ordre, un tour à la fois par conversation. Le
// loader est SOUS le message en cours de traitement : quand sa réponse
// arrive, il passe sous le suivant.
//
// Le runner écrit le tour de l'utilisateur AVANT d'appeler le modèle
// (`run-chat-turn.ts`, 1b), mais l'action serveur n'en revient qu'avec la
// réponse, et le fil — rendu côté serveur — ne se relit qu'après. Ce composant
// comble ce temps-là, côté client, avec ce qu'on SAIT déjà : les textes
// envoyés, et le fait qu'on attend.
//
// Il ne devine rien : chaque copie s'efface D'ELLE-MÊME dès que le fil rendu
// par le serveur porte son texte (`requests`) — c'est le fil qui fait foi,
// jamais cette copie.
//
// Depuis #152, il montre aussi la réponse PENDANT qu'elle s'écrit : le texte
// que le runner diffuse remplace les trois points dès le premier mot. Ce texte
// n'est pas une supposition, c'est la réponse elle-même, en train d'arriver ;
// ce qui n'a pas changé, c'est qui fait foi. Le tour relu prend le relais ; et
// quand le flux échoue, la copie ENTIÈRE quitte le fil — sa phrase à moitié
// écrite avec elle, plutôt que figée là comme si c'était la réponse (inv. #4).

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import Markdown from '@/components/Markdown.tsx';
import ClampedText from '@/app/(dashboard)/spaces/ClampedText.tsx';
import { originLabel } from '@/app/(dashboard)/spaces/format.ts';

type Pending = {
  id: number;
  /** Le texte envoyé, tel quel. */
  text: string;
  /** Combien de fois ce texte était DÉJÀ dans le fil (rendu ou en attente)
   *  au moment de l'envoi : la copie s'efface quand le fil en porte un de
   *  plus. Deux « ok » de suite s'effacent donc l'un après l'autre. */
  baseline: number;
  /** L'envoi a répondu : le tour est joué, le fil va le montrer. */
  settled: boolean;
  /** La réponse telle qu'on la connaît À CET INSTANT (#152). Vide tant que
   *  rien n'est arrivé — et la copie entière part si le flux échoue. */
  reply: string;
};

type Store = {
  /** Les copies que le serveur n'a pas encore rendues, dans l'ordre. */
  pending: readonly Pending[];
  /** Un envoi au moins n'a pas encore reçu sa réponse. */
  inFlight: boolean;
  /** Le fil rendu se termine sur une demande dont la réponse n'est pas là. */
  awaitingReply: boolean;
  /** Ce que l'envoi en cours a reçu de sa réponse jusqu'ici — le premier
   *  envoi non joué, celui que le runner traite. */
  streamingReply: string;
  begin: (text: string) => number;
  /** La réponse ENTIÈRE connue à cet instant, pour cet envoi. Pas un
   *  fragment : l'appelant accumule, ce porteur ne fait qu'afficher. */
  stream: (id: number, reply: string) => void;
  /** L'envoi a réussi : la copie reste jusqu'à ce que le fil la porte. */
  settle: (id: number) => void;
  /** L'envoi a échoué : la copie quitte le fil. */
  end: (id: number) => void;
  /**
   * Tenue quand le fil rendu porte le texte de cet envoi — quand la copie a
   * disparu à l'ÉCRAN, pas quand le serveur a répondu. Un appel d'action
   * serveur depuis le client passe par une transition, et React lie entre
   * elles les transitions en cours : lancer l'envoi suivant avant que la
   * relecture soit affichée la liait à lui, et l'écran ne bougeait qu'à la
   * fin de la série (Quentin, 18/09, trois réponses d'un coup).
   */
  rendered: (id: number) => Promise<void>;
};

const NOOP: Store = {
  pending: [],
  inFlight: false,
  awaitingReply: false,
  streamingReply: '',
  begin: () => 0,
  stream: () => {},
  settle: () => {},
  end: () => {},
  rendered: () => Promise.resolve(),
};
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
  awaitingReply,
  children,
}: {
  /** Les demandes que le serveur a rendues, dans l'ordre du fil. */
  requests: readonly string[];
  /** Le fil rendu se termine sur une demande sans réponse. */
  awaitingReply: boolean;
  children: ReactNode;
}) {
  const [all, setAll] = useState<readonly Pending[]>([]);
  const nextId = useRef(0);
  // Une dérivation, pas un effet : rien à synchroniser, rien à oublier.
  const pending = stillPending(all, requests);
  const isRendered = (id: number): boolean => {
    const p = all.find((x) => x.id === id);
    return p === undefined || (p.settled && !pending.includes(p));
  };
  // Ceux qui attendent que leur copie ait quitté l'écran. Un effet, pas un
  // état : il ne rend rien, il tient une promesse une fois le rendu commis.
  const waiters = useRef(new Map<number, () => void>());
  useEffect(() => {
    for (const [id, wake] of waiters.current) {
      if (isRendered(id)) {
        waiters.current.delete(id);
        wake();
      }
    }
  });
  const store: Store = {
    pending,
    inFlight: all.some((p) => !p.settled),
    awaitingReply,
    // Celui que le runner traite : le premier envoi dont le tour n'est pas
    // joué. Lu sur `all` et non sur `pending`, parce qu'une copie peut déjà
    // avoir quitté l'écran (le fil l'a rendue) pendant que sa réponse arrive.
    streamingReply: all.find((p) => !p.settled)?.reply ?? '',
    begin: (text) => {
      const id = ++nextId.current;
      const baseline =
        countOf(requests, text) +
        countOf(
          pending.map((p) => p.text),
          text,
        );
      // On range en passant ce que le fil a déjà rendu ET dont le tour est joué.
      setAll((prev) => [
        ...prev.filter((p) => !p.settled || countOf(requests, p.text) <= p.baseline),
        { id, text, baseline, settled: false, reply: '' },
      ]);
      return id;
    },
    stream: (id, reply) => setAll((prev) => prev.map((p) => (p.id === id ? { ...p, reply } : p))),
    settle: (id) => setAll((prev) => prev.map((p) => (p.id === id ? { ...p, settled: true } : p))),
    end: (id) => setAll((prev) => prev.filter((p) => p.id !== id)),
    // Toujours tenue par l'effet, jamais ici : la fermeture d'où l'on appelle
    // date du rendu d'AVANT l'envoi, elle ne connaît pas encore la copie.
    // `settle` vient d'être appelé, un rendu suit, l'effet regarde.
    rendered: (id) =>
      new Promise<void>((resolve) => {
        waiters.current.set(id, resolve);
      }),
  };
  return <PendingTurnContext.Provider value={store}>{children}</PendingTurnContext.Provider>;
}

/** Sans porteur (un test qui monte la saisie seule), les gestes ne font rien. */
export function usePendingTurn(): Store {
  return useContext(PendingTurnContext);
}

/** L'agent, à gauche : son en-tête, puis sa réponse en train de s'écrire —
 *  ou, tant qu'aucun mot n'est arrivé, trois points qui battent. */
function Thinking({
  agentName,
  agentAvatarUrl,
  reply = '',
}: {
  agentName: string;
  agentAvatarUrl: string | null;
  /** Le texte déjà reçu (#152). Vide : l'agent n'a encore rien dit. */
  reply?: string;
}) {
  return (
    <div className="min-w-0 pt-6" data-testid="pending-thinking">
      <div className="mb-1.5 flex items-center gap-2.5">
        <AgentAvatar name={agentName} imageUrl={agentAvatarUrl} size="sm" shape="square" />
        <span className="text-title-15 text-ink">{agentName}</span>
      </div>
      {reply === '' ? (
        <div className="flex items-center gap-2 text-mono-11 text-feed-reasoning">
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-feed-reasoning [animation-delay:300ms]" />
          </span>
          <span>thinking</span>
        </div>
      ) : (
        // Rendu comme la réponse le sera une fois le fil relu — même Markdown,
        // même ton — pour que le texte ne saute pas quand le tour la remplace.
        <div data-testid="pending-reply">
          <Markdown text={reply} />
        </div>
      )}
    </div>
  );
}

export default function PendingTurn({
  agentName,
  agentAvatarUrl = null,
}: {
  agentName: string;
  agentAvatarUrl?: string | null;
}) {
  const { pending, inFlight, awaitingReply, streamingReply } = usePendingTurn();
  // Le loader est sous le message que le runner traite : celui que le fil
  // rendu porte déjà sans réponse — si un envoi est en vol : un fil qui se
  // termine sur une demande sans réponse (un tour qui a échoué hier) ne fait
  // pas réfléchir l'agent pour de faux — sinon la première copie en attente.
  const thinkingAfterFeed = awaitingReply && inFlight;
  if (pending.length === 0 && !thinkingAfterFeed) return null;

  return (
    <div className="mx-auto max-w-[760px]" data-testid="pending-turn" aria-live="polite">
      {thinkingAfterFeed && (
        <Thinking agentName={agentName} agentAvatarUrl={agentAvatarUrl} reply={streamingReply} />
      )}
      {pending.map((p, i) => (
        <div key={p.id}>
          {/* Le message qui vient de partir, à droite, comme il sera rendu. */}
          <div className="flex justify-end pt-6" data-testid="pending-message">
            <div className="max-w-[80%] min-w-0">
              <p className="mb-1.5 text-right text-mono-11 text-ink-4">
                {originLabel({ channel: 'dashboard', scheduleName: null, chatId: null })}
              </p>
              {/* Rendu EXACTEMENT comme la demande le sera (`ConversationFeedView`,
                  `case 'request'`) : même bulle, même Markdown — la hauteur ne
                  saute pas quand le vrai tour remplace la copie (Reviewer C). */}
              <div className="rounded-xl bg-hover px-4 py-3" data-testid="pending-text">
                <ClampedText plain={p.text}>
                  <Markdown text={p.text} tone="user" />
                </ClampedText>
              </div>
            </div>
          </div>
          {!thinkingAfterFeed && i === 0 && (
            <Thinking agentName={agentName} agentAvatarUrl={agentAvatarUrl} reply={p.reply} />
          )}
        </div>
      ))}
    </div>
  );
}
