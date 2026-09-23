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
 * Ce que le MODÈLE lit, dans l'historique, sous une réponse arrêtée (#456).
 *
 * La personne, elle, ne lit jamais cette ligne : l'arrêt est un FAIT enregistré
 * (`chat_messages.stopped`) que l'écran dit avec ses mots (invariant #2, revue
 * Codex de #459). Le modèle en a besoin autrement : sans elle, il relirait sa
 * réponse coupée comme une réponse finie. Même famille que les autres consignes
 * `[système]` adressées au modèle.
 */
export function stoppedReplyNote(): string {
  return '[système] La personne a arrêté cette réponse pendant son écriture ; le texte ci-dessus est ce qui avait été écrit.';
}

/**
 * Ce que le MODÈLE lit sous une réponse qu'une horloge de silence a coupée
 * (#458). Même raison que la note d'arrêt : sans elle, il relirait un texte
 * interrompu comme une réponse finie. La personne voit le fait
 * (`chat_messages.cut_reason`), dit par l'écran.
 *
 * (Le flux d'un tour de chat n'a plus besoin de sa propre course contre le
 * Stop : il passe par `consumeUnderClocks`, qui la fait déjà, #458.)
 */
export function cutReplyNote(): string {
  return "[système] Cette réponse a été coupée avant sa fin : le modèle a cessé d'écrire. Le texte ci-dessus est ce qui avait été écrit.";
}
