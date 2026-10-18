// lib/card-words-notice.ts — dire à la personne quand ses mots sur une carte
// ne sont allés qu'à l'agent qui la tient (#799).
//
// Les mots écrits sur une carte (une note, une réponse, un formulaire) vont
// aussi à la tête du run. Quand cette remise n'a pas lieu — le run a fini, ou
// sa tête est introuvable —, la décision est quand même écrite, et la personne
// le lit ici, là où elle a répondu. La phrase vient de `@nodal-agents/shared`,
// la même que lisent les cartes des canaux.

import { toast } from 'sonner';
import { cardWordsNotice, type CardWordsHandOff } from '@nodal-agents/shared';

export function toastCardWordsHandOff(handOff: CardWordsHandOff): void {
  const notice = cardWordsNotice(handOff);
  if (notice !== null) toast.warning(notice);
}
