// turn-stop.ts — le Stop d'un tour de chat en cours (#456).
//
// Un tour de chat qui répond sans outil n'est pas un job : il n'a pas de ligne
// `agent_jobs` dont le statut pourrait passer à `cancelled`, et le Stop de
// #449/#450 — qui relit ce statut — ne l'atteint pas. Le Stop du chat passe
// donc par la mémoire du runner : le tour en cours d'une conversation y dépose
// son contrôleur d'abandon, et `/api/chat/stop` le déclenche.
//
// Une entrée par conversation suffit : la file de `turn-lane.ts` ne joue
// qu'UN tour à la fois par conversation. Stop arrête CE tour-là ; un message
// déjà mis en file derrière lui part ensuite, comme il l'aurait fait.

const inFlight = new Map<string, AbortController>();

/**
 * Joue `work` avec un signal que `stopChatTurn(conversationId)` déclenche.
 * Le contrôleur n'est retiré que s'il est encore le sien : un tour ne retire
 * jamais celui d'un autre.
 */
export async function withChatTurnStop<T>(
  conversationId: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  inFlight.set(conversationId, controller);
  try {
    return await work(controller.signal);
  } finally {
    if (inFlight.get(conversationId) === controller) inFlight.delete(conversationId);
  }
}

/** Arrête le tour en cours de cette conversation. `false` : aucun tour ne tournait. */
export function stopChatTurn(conversationId: string): boolean {
  const controller = inFlight.get(conversationId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

/**
 * La ligne de plateforme qui clôt une réponse arrêtée. Même nature que
 * `[stopped: llm timeout …]` des jobs : un FAIT posé par la plateforme, entre
 * crochets, jamais la voix de l'agent (invariant #2). Elle reste dans
 * l'historique, et le tour suivant sait donc que sa réponse d'avant a été
 * coupée par la personne.
 */
export const CHAT_STOPPED_LINE = '[stopped by the user]';

/**
 * Parcourt `source` jusqu'à sa fin OU jusqu'au Stop, le premier des deux.
 *
 * L'abandon passé au SDK ne suffit pas seul : ai 6.0.177 ne voit le signal que
 * quand un fragment passe, et un flux encore muet (le modèle qui réfléchit
 * avant son premier mot) garderait la boucle en attente malgré le Stop —
 * vérifié sur #449 avec un modèle simulé qui ne parle jamais. Chaque lecture
 * fait donc la course contre le Stop lui-même.
 */
export async function* untilStopped<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  if (!signal) {
    for (let next = await it.next(); !next.done; next = await it.next()) yield next.value;
    return;
  }
  const stopped = new Promise<'stopped'>((resolve) => {
    if (signal.aborted) resolve('stopped');
    else signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });
  while (true) {
    const read = it.next();
    // Une lecture encore en attente au moment du Stop se règle plus tard, dans le vide.
    read.catch(() => {});
    const next = await Promise.race([read, stopped]);
    if (next === 'stopped') {
      void it.return?.()?.catch(() => {});
      return;
    }
    if (next.done) return;
    yield next.value;
  }
}
