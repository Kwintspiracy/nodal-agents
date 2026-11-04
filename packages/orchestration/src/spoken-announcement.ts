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
//     demande, même quand le résultat en a une autre ;
//   - « garde le fait sans lequel la personne serait trompée (pas fini, pas
//     confirmé) » a fait repasser le contenu de la recherche par ses réserves
//     (« the rumoured January cuts are unconfirmed », 5/5 de 37 à 44 mots) :
//     le fait gardé est l'état du TRAVAIL (une impression en cours, un envoi
//     non remis), jamais une réserve de son contenu ; pour un travail,
//     « seulement que c'est fait », en une phrase (la tournure de la v3, qui
//     tenait 0/5) ;
//   - « never say where to read it » n'a pas suffi (« I've put the summary in
//     the chat for you to read », 3/5) : la consigne nomme ce qui est exclu
//     (pas dans Nodal, pas dans le chat, pas « prêt à lire ») ; et l'état d'une
//     impression a nommé le modèle de l'imprimante (1/5) : l'état se dit sans
//     nommer un appareil, un modèle ou un fichier.
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
      'a send), say only that it is done, in one short sentence. Nothing from its content: ' +
      'no gist, no main story, no finding, no number, no name, no caveat about what it says.\n' +
      '- If the work itself is not finished or not confirmed yet (a print still running, a ' +
      'message not delivered), add that in a few words, without naming a device, a model or ' +
      'a file. That is the only thing you add.\n' +
      '- Never say where it is or that it can be read (not in Nodal, not in the chat, not ' +
      '"ready for you to read"), and never offer to send it anywhere: they know.\n' +
      '- No stock phrase: say it the way you would say it this time.\n' +
      '- Never say a web address, a file path or markup, and never explain what you are ' +
      'saying or leaving out, or why.\n' +
      'One or two short sentences.',
  };
}
