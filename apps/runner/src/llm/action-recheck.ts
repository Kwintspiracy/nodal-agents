// llm/action-recheck.ts — relire une réponse qui promettait une action (#600).
//
// Un modèle répond en prose en ANNONÇANT une action (« Je délègue la réécriture
// à Dev-C. », « Je lance la recherche. ») sans émettre l'appel d'outil qui la
// ferait. Le texte seul ne fait rien. Le tool_choice n'est jamais forcé (#600) :
// un tour peut être une vraie réponse, et un appel forcé faisait planifier à un
// modèle de raisonnement toute une trajectoire en une seule réponse (64 à 546
// appels, ou le plafond de sortie).
//
// Un seul mécanisme pour le chat ET la boucle de job : tout tour qui finit en
// prose sans appel d'outil est relu UNE fois. Le modèle voit la demande, sa
// réponse, et la consigne, avec les outils de l'appelant. Il appelle l'outil
// que sa réponse promettait, ou n'appelle rien et la réponse reste.
//
// La relance est LOCALE, jamais le tour rejoué : ni prompt système, ni
// historique, ni mémoire. Mesuré le 09/09 sur le chat, la relance complète
// coûtait ~9 300 jetons, autant que la réponse elle-même (18 500 par tour pour
// un bonjour). La question « ma réponse promettait-elle une action ? » ne
// dépend que de la demande et de la réponse relue.
//
// La consigne est adressée au modèle, jamais montrée à l'utilisateur
// (invariant #2) : elle ne vit que dans la requête de relance.

import type { ModelMessage } from 'ai';
import type { NodalLlmClient } from '@nodal-agents/llm';

export const ACTION_RECHECK =
  'Re-read your previous reply. If it committed to performing an action — running, launching, ' +
  'sending, fetching, creating, configuring, delegating, or any task or tool use — then your ' +
  'text ALONE did nothing: call the tool that performs it NOW, conveying the request ' +
  'faithfully (its words and data, with no invented scope, method, or delivery). ' +
  'If your reply was pure conversation, a question, an answer, or simply recalling a fact, do ' +
  'not call any tool — the reply stands as it is.';

/** Les trois messages de la relance : la demande, la réponse relue, la consigne. */
export function actionRecheckMessages(request: string, reply: string): ModelMessage[] {
  return [
    { role: 'user', content: request },
    { role: 'assistant', content: reply },
    { role: 'user', content: ACTION_RECHECK },
  ];
}

/**
 * Relit `reply` contre `request` avec les outils de l'appelant. Rend la réponse
 * de la relance telle quelle : l'appelant lit ses appels d'outils (aucun =
 * la réponse relue reste la réponse), et décide de ses erreurs.
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
