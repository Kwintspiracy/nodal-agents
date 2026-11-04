// spoken-announcement.ts — ce que l'agent DIT quand un job lancé par la voix finit (#967).
//
// La règle du propriétaire (04/11, issue #967) : un job lancé à la voix finit
// par DEUX choses, écrites l'une et l'autre par l'agent.
//   1. Le RÉSULTAT, écrit pour être lu, comme aujourd'hui : un long document
//      de recherche convient. Il reste tel quel dans le fil, dans Runs et sur
//      toute autre surface. Le prompt du job ne dit donc plus « ta réponse est
//      entendue » : elle ne l'est pas.
//   2. Une ANNONCE courte, écrite pour l'oreille : un résultat court est
//      simplement dit (« C'est imprimé. ») ; un document n'est jamais lu à voix
//      haute — l'annonce dit qu'il est prêt, où le lire, et propose de
//      l'envoyer sur un canal où la personne est vraiment joignable.
//
// L'annonce est une génération de plus, après la fin du job, par le MÊME agent
// (sa personnalité, son modèle), à partir de la demande et du résultat. Ce
// module en construit la consigne ; le runner l'appelle et la dit
// (apps/runner/src/chat/job-reply-voice.ts). Le runner ne compose rien, ne
// coupe rien, ne choisit aucun morceau du résultat à dire (invariant #2).
//
// LES CANAUX viennent des données de l'espace (`reachableChannels`) : les
// liaisons ACTIVES de l'agent qui ont au moins une conversation approuvée —
// celles où un envoi arrive vraiment. Jamais une liste du code.
//
// LA CONSIGNE, mesurée (rejeu sur le job f7aecffd, 04/11) : avec la règle dans
// le seul prompt système, et le résultat entier dans le message, Haiku 5.5 a
// résumé le rapport cinq fois sur cinq (122 à 162 mots), puis ajouté « le
// rapport complet est dans Nodal ». Le résultat cité TIRE vers le résumé. La
// règle est donc dite APRÈS le résultat, dans le message, et elle est
// tranchée pour un document : rien de ce qu'il dit — ni l'essentiel, ni un
// chiffre, ni un constat —, seulement qu'il est prêt, où le lire, et l'offre.
// La ligne de forme du tour vocal (`replyRenderingLine`) n'est PAS reprise :
// son « la première phrase part pendant que la suite s'écrit » appelle une
// suite, et une annonce n'en a pas. C'est le modèle qui juge si le résultat
// est court ou un document ; le runner ne mesure aucune longueur.

import { countActiveConversations, listChannelBindings } from '@nodal-agents/db';
import type { AnyDrizzleDb } from './types';

/**
 * Les canaux où l'agent peut joindre la personne : ses liaisons activées qui
 * ont au moins une conversation approuvée (un envoi vers une liaison sans
 * conversation n'arrive nulle part). Dans l'ordre de la base.
 */
export async function reachableChannels(db: AnyDrizzleDb, agentId: string): Promise<string[]> {
  const bindings = (await listChannelBindings(db, agentId)).filter((b) => b.enabled);
  const reachable: string[] = [];
  for (const b of bindings) {
    if ((await countActiveConversations(db, agentId, b.channel)) > 0) reachable.push(b.channel);
  }
  return reachable;
}

/**
 * La consigne de l'annonce : le système (la personnalité de l'agent, et le
 * fait que ce qu'il écrit est dit) et le message (la demande de la personne,
 * le résultat cité tel qu'en base, puis la règle de l'annonce).
 */
export function buildSpokenAnnouncement(input: {
  /** `agents.personality`, telle quelle. */
  personality: string;
  /** `reachableChannels` : les canaux où l'envoi est possible. */
  channels: readonly string[];
  /** `agent_jobs.task` : les mots de la personne. */
  request: string;
  /** `agent_jobs.result` : le résultat, tel que le fil le montre. */
  result: string;
}): { system: string; prompt: string } {
  // Le roster de l'équipe n'a rien à faire dans une annonce : le
  // marqueur reste vide, comme sans équipe.
  const personality = input.personality.replace('{{team}}', '').trim();
  const offer =
    input.channels.length > 0
      ? `and offer to send it to them on ${input.channels.join(' or ')}`
      : 'and nothing else: there is no channel you can send it on';
  return {
    system:
      `${personality}\n\n## Announcement\n` +
      'The work the person asked you for has just finished. You are now telling them, out ' +
      'loud: what you write is turned into speech and heard, not read.',
    prompt:
      `The person asked:\n${input.request.trim()}\n\n` +
      'The result of the work, written in the conversation where they can read it:\n' +
      `<<<\n${input.result.trim()}\n>>>\n\n` +
      'Write only what you say to them now, in the language of their request.\n' +
      '- If the result is a short answer (a fact, a confirmation, a sentence or two), say it ' +
      'in plain spoken words. Never say a web address, a file path or markup.\n' +
      '- Otherwise it is a document. Do not tell them what it says: no summary, no finding, ' +
      'no number, no name from it. Say only that it is ready, that they can read it in Nodal, ' +
      `${offer}. Two short sentences at most.`,
  };
}
