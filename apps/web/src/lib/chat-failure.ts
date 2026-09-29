// chat-failure.ts — ce que l'écran dit d'un tour de chat qui n'a pas rendu de
// réponse, à UN endroit pour le flux (chat-stream.ts) et l'action serveur
// (sendChatMessageAction).
//
// Un tour COUPÉ n'est pas un tour « sans réponse » (#484) : le runner dit
// qu'une horloge a coupé l'appel au modèle (`llm_cut`) et laquelle
// (`cutReason`). L'écran le dit, une phrase par raison. Une raison qu'il ne
// connaît pas est montrée telle quelle, jamais remplacée par un message
// générique qui cacherait la coupure.

/** La phrase de l'écran pour chaque raison de coupure que le runner pose. */
const CUT_REASON_TEXT: Readonly<Record<string, string>> = {
  invisible_production: 'The model call was cut: it ran too long without writing a reply.',
  stream_error: 'The model call was cut: the connection to the model broke.',
  idle_before_first_token: 'The model call was cut: the model did not start answering in time.',
  idle_between_tokens: 'The model call was cut: the model went silent.',
  absolute: 'The model call was cut: it reached its one-hour limit.',
  wall: 'The model call was cut: it took too long.',
};

/** Une coupure dite à l'écran : la phrase de sa raison, ou la raison telle quelle. */
export function cutReasonText(reason: string | null | undefined): string {
  if (!reason) return 'The model call was cut, with no reason given.';
  return CUT_REASON_TEXT[reason] ?? `The model call was cut (${reason}).`;
}

/** Le même vocabulaire d'erreurs pour le flux et l'action serveur, en clair. */
export function chatFailureText(code: string, cutReason?: string | null): string {
  if (code === 'llm_cut') return cutReasonText(cutReason);
  if (code === 'agent_no_llm_configured') return 'This agent has no model configured';
  if (code === 'agent_inactive') return 'This conversation’s agent is disabled.';
  if (code === 'conversation_not_found') return 'Conversation not found';
  return 'The agent did not reply';
}
