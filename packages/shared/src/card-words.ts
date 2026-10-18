// card-words.ts — ce que sont devenus les mots qu'une personne a écrits sur
// une carte, au-delà de l'agent qui la tient (#799).
//
// Les mots (une note, une réponse, un formulaire) vont à l'agent de la carte
// dans son résultat d'outil, et AUSSI à la tête du run. La décision est écrite
// quoi qu'il arrive à cette remise ; quand la remise n'a pas lieu alors que la
// personne attendait qu'on la lise, la personne le lit là où elle a répondu
// (le dashboard, ou la carte du canal) : `cardWordsNotice`.

/** Ce qu'est devenue la remise à la tête du run. */
export type CardWordsHandOff =
  /** La carte ne porte aucun mot de la personne : rien à remettre. */
  | { readonly kind: 'no_words' }
  /** Écrits dans la file de la tête, qui les lit à son pas suivant. */
  | { readonly kind: 'delivered'; readonly headJobId: string }
  /** La carte est sur la tête elle-même : son résultat d'outil les porte. */
  | { readonly kind: 'is_head' }
  /** La tête a fini : seul l'agent de la carte les lit. */
  | { readonly kind: 'head_finished'; readonly headJobId: string; readonly status: string | null }
  /** La tête du run est introuvable (chaîne de parents rompue) : seul l'agent de la carte les lit. */
  | { readonly kind: 'no_head'; readonly reason: string };

/**
 * La phrase que la personne lit quand ses mots ne sont allés qu'à l'agent de
 * la carte, ou `null` quand il n'y a rien à lui dire.
 */
export function cardWordsNotice(handOff: CardWordsHandOff): string | null {
  switch (handOff.kind) {
    case 'head_finished':
      return 'Only the agent on this card gets your words: its run has already finished.';
    case 'no_head':
      return 'Only the agent on this card gets your words: its run could not be found.';
    case 'no_words':
    case 'delivered':
    case 'is_head':
      return null;
  }
}
