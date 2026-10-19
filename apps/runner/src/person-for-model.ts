// person-for-model.ts — comment un texte destiné à un modèle nomme une personne.
//
// LA RÈGLE (#810) : un texte qui part chez un fournisseur de modèle nomme une
// personne par son RÔLE et un identifiant OPAQUE, jamais par une donnée de
// contact (adresse e-mail, numéro de téléphone). Le modèle n'a pas besoin de
// savoir comment joindre quelqu'un pour savoir qui a parlé : le rôle le dit,
// et un identifiant suffit à distinguer deux personnes.
//
// Le défaut qui l'a fait écrire : le cadre des mots d'une carte (card-words.ts)
// disait `user:<email>` pour une réponse du dashboard — l'adresse partait dans
// la requête suivante de la tête du run. Et `?? userId` changeait la forme en
// silence quand le compte n'existait plus.
//
// Toutes les identités de personne que le runner écrit pour un modèle passent
// par ce module, et l'identifiant y est toujours celui d'une ligne À NOUS :
//   - un COMPTE : `users.id` ;
//   - une CONVERSATION de canal : la ligne qui l'autorise (et lui donne son
//     rôle), jamais l'identifiant du canal — celui de WhatsApp est le numéro
//     de téléphone de la personne (`33612345678@s.whatsapp.net`) ;
//   - un PARTICIPANT d'un groupe : le nom qu'il s'est donné sur le canal, et
//     le pseudo du canal quand il en a un. C'est la seule exception assumée à
//     « identifiant opaque » : dans un groupe, l'agent lit une conversation
//     entre plusieurs personnes et doit savoir qui dit quoi, sous le nom que
//     les autres membres voient. Ce nom et ce pseudo sont affichés à tout le
//     groupe par le canal ; ni l'un ni l'autre n'est un e-mail ni un numéro.
//
// Quand la ligne manque, la forme le dit, fixe — jamais une autre forme
// choisie en silence (invariant #4).

/** Une personne, telle que les données la connaissent. */
export type PersonForModel =
  /** Un compte du dashboard ou de l'API. `found: false` : aucune ligne `users` pour cet id. */
  | { readonly kind: 'account'; readonly userId: string; readonly found: boolean }
  /**
   * Une conversation de canal autorisée, par la ligne qui l'autorise
   * (`telegram_allowed_chats.id`, `channel_allowed_conversations.id`) ; `null`
   * quand aucune ligne ne l'autorise.
   */
  | {
      readonly kind: 'conversation';
      readonly channel: string;
      readonly allowedConversationId: string | null;
    }
  /**
   * Un participant d'un groupe : son nom affiché, déjà assaini
   * (`sanitizeSenderName`, qui dit `Someone` quand il n'y en a aucun), et le
   * pseudo du canal quand il en a un.
   */
  | { readonly kind: 'participant'; readonly displayName: string; readonly handle: string | null };

/** L'identité de cette personne dans un texte pour un modèle. */
export function personForModel(person: PersonForModel): string {
  switch (person.kind) {
    case 'account':
      return person.found
        ? `user:${person.userId}`
        : `user:${person.userId} (no account with this id)`;
    case 'conversation':
      return person.allowedConversationId === null
        ? `${person.channel}:(no allowed conversation)`
        : `${person.channel}:${person.allowedConversationId}`;
    case 'participant':
      return person.handle ? `${person.displayName} (@${person.handle})` : person.displayName;
  }
}

/** Le « qui parle » d'un message de groupe, devant ce que la personne a tapé. */
export function groupMessagePrefix(displayName: string, handle: string | null = null): string {
  return `[Message from ${personForModel({ kind: 'participant', displayName, handle })}]: `;
}
