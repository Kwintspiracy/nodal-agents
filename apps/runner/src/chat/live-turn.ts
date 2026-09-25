// live-turn.ts — le texte d'un tour de chat EN COURS, lisible par une autre page (#457).
//
// Le texte qui s'écrit ne vivait que dans la page qui avait envoyé le message :
// la personne ouvrait une autre page et revenait, la question était là, la
// réponse non, et rien ne disait qu'elle s'écrivait encore. Elle apparaissait
// d'un coup, des minutes plus tard (conversation `66215d0d`, 23/09). Le runner,
// lui, n'avait jamais cessé d'écrire.
//
// Le tour en cours d'une conversation dépose donc ici ce qu'il a écrit jusque-là,
// et le diffuse à qui s'y rebranche. L'entrée vit le temps du tour, et pas une
// seconde de plus : ce qui fait foi ensuite, c'est la ligne `chat_messages`.
//
// Une entrée par conversation suffit : la file de `turn-lane.ts` ne joue qu'UN
// tour à la fois par conversation (même raisonnement que `turn-stop.ts`).

/** Ce qu'un auditeur reçoit : un fragment, ou la fin du tour. */
export type LiveTurnEvent = { kind: 'delta'; text: string } | { kind: 'end' };

interface LiveTurn {
  entityId: string;
  startedAt: number;
  text: string;
  listeners: Set<(evt: LiveTurnEvent) => void>;
}

const live = new Map<string, LiveTurn>();

/**
 * Joue `work` en tenant son texte lisible. `say` reçoit chaque fragment de la
 * réponse ; un tour qui ne diffuse rien (runtime CLI, chemin sans flux) ne
 * l'appelle jamais, et reste pourtant visible comme un tour EN COURS.
 */
export async function withLiveTurn<T>(
  entityId: string,
  conversationId: string,
  work: (say: (delta: string) => void) => Promise<T>,
): Promise<T> {
  const turn: LiveTurn = { entityId, startedAt: Date.now(), text: '', listeners: new Set() };
  live.set(conversationId, turn);
  const emit = (evt: LiveTurnEvent): void => {
    for (const listener of turn.listeners) {
      try {
        listener(evt);
      } catch {
        // Un auditeur parti (onglet fermé) ne casse ni le tour ni les autres.
      }
    }
  };
  try {
    return await work((delta) => {
      turn.text += delta;
      emit({ kind: 'delta', text: delta });
    });
  } finally {
    // Le tour n'est retiré que s'il est encore le sien : jamais celui d'un autre.
    if (live.get(conversationId) === turn) live.delete(conversationId);
    emit({ kind: 'end' });
    turn.listeners.clear();
  }
}

/**
 * Se rebranche sur le tour en cours de cette conversation : ce qui a été écrit
 * jusqu'ici, puis chaque fragment et la fin, par `listener`. `null` : aucun
 * tour ne tourne pour cette conversation dans cette entité.
 */
export function attachLiveTurn(
  entityId: string,
  conversationId: string,
  listener: (evt: LiveTurnEvent) => void,
): { text: string; startedAt: number; detach: () => void } | null {
  const turn = live.get(conversationId);
  // Même identifiant, autre entité : on ne lit jamais le tour d'une autre.
  if (!turn || turn.entityId !== entityId) return null;
  turn.listeners.add(listener);
  return {
    text: turn.text,
    startedAt: turn.startedAt,
    detach: () => {
      turn.listeners.delete(listener);
    },
  };
}
