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
// La forme « entendue » est la ligne même du tour vocal (`replyRenderingLine`,
// system-prompt.ts) : une seule définition de ce qu'une voix rend, lue par
// tout ce qui est dit.

import { countActiveConversations, listChannelBindings } from '@nodal-agents/db';
import type { AnyDrizzleDb } from './types';
import { replyRenderingLine } from './system-prompt';

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
 * La consigne de l'annonce : le système (la personnalité de l'agent, la forme
 * entendue, ce qu'il annonce et vers où) et le message (la demande de la
 * personne et le résultat, cités tels qu'en base).
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
  const rendering = replyRenderingLine({ origin: 'dashboard', replyRendering: 'spoken' });
  const offer =
    input.channels.length > 0
      ? `offer to send it to them on ${input.channels.join(' or ')}`
      : 'there is no channel you can send it on, so say only where to read it';
  const announcement =
    '- announcement: the work the person asked you for has just finished, and you now tell ' +
    'them so, out loud. Its result is written in the conversation, where it stays for ' +
    'reading; the message below quotes their request and that result. Speak in the ' +
    'language of their request, in a few short sentences. A short result (a fact, a ' +
    'confirmation, a sentence or two) is simply said. A longer one (a report, a list, ' +
    'sources, a document) is never read out: say it is ready, that they can read it in ' +
    `Nodal, and ${offer}. ` +
    'Say no address and no list. Their answer to you is their next message.';
  return {
    system: `${personality}\n\n## Job context\n${rendering ?? ''}\n${announcement}`,
    prompt:
      `The person asked:\n${input.request.trim()}\n\n` +
      `The result of the work, as the conversation shows it:\n${input.result.trim()}`,
  };
}
