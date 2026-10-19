// person-for-model.ts — comment un texte destiné à un modèle nomme une personne.
//
// LA RÈGLE (#810) : un texte qui part chez un fournisseur de modèle nomme une
// personne par son RÔLE et un identifiant, jamais par une donnée de contact
// qu'on n'a pas besoin de lui donner (son adresse e-mail). Le modèle n'a pas
// besoin de savoir comment joindre quelqu'un pour savoir qui a parlé : le rôle
// le dit, et un identifiant suffit à distinguer deux personnes.
//
// Le défaut qui l'a fait écrire : le cadre des mots d'une carte (card-words.ts)
// disait `user:<email>` pour une réponse du dashboard — l'adresse partait dans
// la requête suivante de la tête du run. Et `?? userId` changeait la forme en
// silence quand le compte n'existait plus.
//
// Toutes les identités de personne que le runner écrit pour un modèle passent
// par ce module :
//   - un COMPTE : `users.id`, jamais son e-mail ;
//   - une CONVERSATION de canal : l'identifiant de conversation du canal — le
//     MÊME espace d'adresses que le modèle lit partout ailleurs (contexte du
//     job, `list_conversations`, entrée des outils d'envoi). Un second espace
//     (l'id d'une ligne à nous) ressemblerait à une adresse sans en être une
//     (revue Reviewer A de #820, passe 1). Un identifiant opaque unique pour
//     toutes les adresses de conversation est une décision à part ;
//   - un PARTICIPANT d'un groupe : le nom qu'il s'est donné sur le canal, et
//     le pseudo du canal quand il en a un. Dans un groupe, l'agent lit une
//     conversation entre plusieurs personnes et doit savoir qui dit quoi, sous
//     le nom que les autres membres voient. Ce nom et ce pseudo sont affichés
//     à tout le groupe par le canal ; ni l'un ni l'autre n'est un e-mail ni un
//     numéro. Ils sont assainis ICI (`sanitizeSenderName`), quel que soit
//     l'appelant : un nom de canal est du texte libre qu'un inconnu choisit.
//
// Quand la ligne du compte manque, la forme le dit, fixe — jamais une autre
// forme choisie en silence (invariant #4).

import { sanitizeSenderName } from './channels/shared.ts';

/** Une personne, telle que les données la connaissent. */
export type PersonForModel =
  /** Un compte du dashboard ou de l'API. `found: false` : aucune ligne `users` pour cet id. */
  | { readonly kind: 'account'; readonly userId: string; readonly found: boolean }
  /** Une conversation de canal, par l'identifiant que le canal lui donne. */
  | { readonly kind: 'conversation'; readonly channel: string; readonly conversationId: string }
  /** Un participant d'un groupe : son nom affiché, et le pseudo du canal quand il en a un. Bruts. */
  | { readonly kind: 'participant'; readonly displayName: string; readonly handle: string | null };

/** L'identité de cette personne dans un texte pour un modèle. */
export function personForModel(person: PersonForModel): string {
  switch (person.kind) {
    case 'account':
      return person.found
        ? `user:${person.userId}`
        : `user:${person.userId} (no account with this id)`;
    case 'conversation':
      return `${person.channel}:${person.conversationId}`;
    case 'participant': {
      // `sanitizeSenderName` dit `Someone` pour un nom vide ; un pseudo vide
      // n'est pas un pseudo, il n'est pas écrit.
      const name = sanitizeSenderName(person.displayName);
      const handle = person.handle ? sanitizeSenderName(person.handle) : null;
      return handle ? `${name} (@${handle})` : name;
    }
  }
}

/** Le « qui parle » d'un message de groupe, devant ce que la personne a tapé. */
export function groupMessagePrefix(displayName: string, handle: string | null = null): string {
  return `[Message from ${personForModel({ kind: 'participant', displayName, handle })}]: `;
}
