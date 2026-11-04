// spoken-announcement.ts — ce que l'agent DIT quand un job lancé par la voix finit (#967).
//
// La règle du propriétaire (04/11, issue #967) : un job lancé à la voix finit
// par DEUX choses, écrites l'une et l'autre par l'agent.
//   1. Le RÉSULTAT, écrit pour être lu, comme aujourd'hui : un long document
//      de recherche convient. Il reste tel quel dans le fil, dans Runs et sur
//      toute autre surface. Le prompt du job ne dit donc plus « ta réponse est
//      entendue » : elle ne l'est pas.
//   2. Une ANNONCE courte, écrite pour l'oreille : l'agent confirme, avec ses
//      mots, que ce qui a été demandé est fait. Un résultat court est dit ; un
//      document n'est jamais lu.
//
// L'annonce est une génération de plus, après la fin du job, par le MÊME agent
// (sa personnalité, son modèle), à partir de la demande et du résultat. Ce
// module en construit la consigne ; le runner l'appelle et la dit
// (apps/runner/src/chat/job-reply-voice.ts). Le runner ne compose rien, ne
// coupe rien, ne choisit aucun morceau du résultat à dire (invariant #2).
//
// LA CONSIGNE, mesurée (rejeux sur la base du propriétaire, 04/11) :
//   - règle dans le seul prompt système, résultat entier dans le message :
//     Haiku 5.5 a résumé le rapport de f7aecffd cinq fois sur cinq (122 à 162
//     mots). Le résultat cité TIRE vers le résumé : la règle est dite APRÈS
//     lui, dans le message, et elle est tranchée pour un document (ni
//     l'essentiel, ni un chiffre, ni un constat) ;
//   - un essai a encore raconté la règle (« it's a document, so I won't read
//     out the details »), comme le tour de #977 racontait son aiguillage :
//     l'annonce n'explique jamais ce qu'elle dit ou tait ;
//   - « où le lire » et l'offre d'un canal, demandés d'abord, ont donné une
//     phrase toute faite, la même à chaque annonce (« You can read the full
//     layout in Nodal, and I can send it to you on Telegram, Discord or
//     Slack »). Le propriétaire : « Je sais où je peux les lire. » Les deux
//     sont retirés, et les canaux avec eux : demander l'envoi reste une
//     demande ordinaire. Aucune formule fixe : c'est l'agent qui parle ;
//   - le critère « résultat court » contre « document » a laissé Haiku classer
//     la recherche de f7aecffd en réponse courte, et la résumer (5/5). Le
//     critère est donc ce qui a été DEMANDÉ, que la consigne cite : une
//     question reçoit sa réponse, un travail (recherche, document, page,
//     fichier, impression, envoi) sa seule confirmation ;
//   - une demande en anglais au résultat en français (b41632f5) a été
//     annoncée en français deux fois sur cinq : la langue est celle de la
//     demande, même quand le résultat en a une autre.
// La ligne de forme du tour vocal (`replyRenderingLine`) n'est PAS reprise :
// son « la première phrase part pendant que la suite s'écrit » appelle une
// suite, et une annonce n'en a pas. C'est le modèle qui juge question ou
// travail ; le runner ne mesure aucune longueur.

/**
 * La consigne de l'annonce : le système (la personnalité de l'agent, et le
 * fait que ce qu'il écrit est dit) et le message (la demande de la personne,
 * le résultat cité tel qu'en base, puis la règle de l'annonce).
 */
export function buildSpokenAnnouncement(input: {
  /** `agents.personality`, telle quelle. */
  personality: string;
  /** `agent_jobs.task` : les mots de la personne. */
  request: string;
  /** `agent_jobs.result` : le résultat, tel que le fil le montre. */
  result: string;
}): { system: string; prompt: string } {
  // Le roster de l'équipe n'a rien à faire dans une annonce : le
  // marqueur reste vide, comme sans équipe.
  const personality = input.personality.replace('{{team}}', '').trim();
  return {
    system:
      `${personality}\n\n## Announcement\n` +
      'The work the person asked you for has just finished. You are now telling them, out ' +
      'loud: what you write is turned into speech and heard, not read.',
    prompt:
      `The person asked:\n${input.request.trim()}\n\n` +
      'The result of the work, written in the conversation where they can read it:\n' +
      `<<<\n${input.result.trim()}\n>>>\n\n` +
      'Tell them, in your own words, that what they asked for is done. Speak the language ' +
      'of their request above, even when the result is written in another language.\n' +
      '- If they asked a question they want answered (a fact, whether something works), ' +
      'say the answer simply, in plain spoken words.\n' +
      '- If they asked for a piece of work (research, a document, a page, a file, a print, ' +
      'a send), only confirm it is done: nothing from its content, no gist, no summary, no ' +
      'finding, no number, no name.\n' +
      '- Never say where to read it, and never offer to send it anywhere: they know.\n' +
      '- If they need a fact so as not to be misled (something not finished or not confirmed ' +
      'yet), keep it, in a few words.\n' +
      '- No stock phrase: say it the way you would say it this time.\n' +
      '- Never say a web address, a file path or markup, and never explain what you are ' +
      'saying or leaving out, or why.\n' +
      'One or two short sentences.',
  };
}
