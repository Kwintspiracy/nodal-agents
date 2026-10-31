// llm/action-recheck.ts — relire une réponse de chat qui promettait une action (#600).
//
// Un modèle répond en prose en ANNONÇANT une action (« Je lance la recherche. »)
// sans émettre l'appel d'outil qui la ferait. Le texte seul ne fait rien. Le
// tool_choice n'est jamais forcé (#600) : un tour peut être une vraie réponse,
// et un appel forcé faisait planifier à un modèle de raisonnement toute une
// trajectoire en une seule réponse (64 à 546 appels, ou le plafond de sortie).
//
// Le CHAT seul s'en sert (`apps/runner/src/chat/run-chat-turn.ts`) : un tour
// qui finit en prose sans appeler `run_task` est relu UNE fois. La boucle des
// jobs ne relit plus rien (#886) : mesurée sur un mois, sa relance répétait
// des actions déjà faites bien plus souvent qu'elle n'en rattrapait une, et
// chaque réponse finale payait un second appel. Le chat garde la sienne,
// inchangée, jusqu'à ce qu'elle soit mesurée à son tour.
//
// La relance est LOCALE, jamais le tour rejoué : ni prompt système, ni
// historique, ni mémoire. Mesuré le 09/09 sur le chat, la relance complète
// coûtait ~9 300 jetons, autant que la réponse elle-même (18 500 par tour pour
// un bonjour).
//
// Le relevé de ce que le tour a fait depuis la demande (#711) est toujours
// vide : un tour de chat n'exécute aucun outil avant sa relance — son seul
// outil, `run_task`, part APRÈS elle, et une réponse qui l'a appelé n'est
// jamais relue. Ce que les tours d'avant ont fait est dans l'historique, que la
// relance ne rejoue pas : la consigne dit qu'une réponse qui le rappelle
// n'engage à rien.
//
// La consigne et le relevé sont adressés au modèle, jamais montrés à
// l'utilisateur (invariant #2) : ils ne vivent que dans la requête de relance.

import type { ModelMessage } from 'ai';
import type { NodalLlmClient } from '@nodal-agents/llm';

export const ACTION_RECHECK =
  'Re-read your previous reply against the record above of what this run has done since the ' +
  'request. ' +
  'An action the record shows as done, or as possibly done with an uncertain outcome, has ' +
  'happened: do not perform it again. ' +
  "An action the record shows as refused by a person, or as waiting for a person's " +
  'decision, must not be performed now either. ' +
  'Any other action your reply reports or commits to — running, launching, sending, ' +
  'fetching, creating, configuring, delegating, or any task or tool use — that the record ' +
  'does not show as done was NOT done: your text ALONE does nothing, so call the tool that ' +
  'performs it NOW, conveying the request faithfully (its words and data, with no invented ' +
  'scope, method, or delivery). ' +
  'If your reply was pure conversation, a question, an answer, or simply recalling a fact, do ' +
  'not call any tool — the reply stands as it is.';

/** Le relevé d'un tour de chat au moment de sa relance : aucun outil n'a tourné. */
export const EMPTY_RUN_RECORD = 'Record of this run: no tool has been called since the request.';

/**
 * Les trois messages de la relance : la demande, la réponse relue, puis le
 * relevé (vide) suivi de la consigne.
 */
export function actionRecheckMessages(request: string, reply: string): ModelMessage[] {
  return [
    { role: 'user', content: request },
    { role: 'assistant', content: reply },
    { role: 'user', content: `${EMPTY_RUN_RECORD}\n\n${ACTION_RECHECK}` },
  ];
}

/**
 * Relit `reply` contre `request`, avec les outils de l'appelant. Rend la
 * réponse de la relance telle quelle : l'appelant lit ses appels d'outils
 * (aucun = la réponse relue reste la réponse), et décide de ses erreurs.
 */
export function recheckNarratedAction(
  client: NodalLlmClient,
  opts: {
    request: string;
    reply: string;
    tools: Parameters<NodalLlmClient['generateText']>[0]['tools'];
    abortSignal?: AbortSignal;
  },
): ReturnType<NodalLlmClient['generateText']> {
  return client.generateText(
    {
      messages: actionRecheckMessages(opts.request, opts.reply),
      tools: opts.tools,
      toolChoice: 'auto',
    },
    opts.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
  );
}
