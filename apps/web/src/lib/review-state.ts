// review-state.ts — CE QUE LA RELECTURE AUTORISE, lu une fois pour les trois
// écrans qui concluent un travail (#59).
//
// Le 19/09/2026 le propriétaire a tranché : un `request_changes` empêche
// d'annoncer « livré ». La décision porte sur le DERNIER verdict enregistré
// sous un travail — le sien ou celui d'un délégué relecteur — et il n'y a
// qu'un endroit où ce « dernier » se choisit : ici.
//
// Module PUR : il ne lit ni la base ni le réseau, il range une liste déjà lue.
// La règle qu'il sert (`reviewBlocksDelivery`) vit dans `@nodal-agents/shared`,
// où l'orchestration la lit aussi pour poser son champ typé.

/**
 * Le dernier verdict de relecture d'une liste ORDONNÉE par `seq` (l'ordre
 * d'écriture des lignes `review_verdict`, croissant — c'est ce que rend
 * `readReviewVerdicts`).
 *
 * Les lignes dont le verdict ne s'est pas lu sont passées : elles ont déjà été
 * NOMMÉES dans le journal par le lecteur qui a échoué à les comprendre
 * (`review-verdicts.ts`), et les compter pour « pas de relecture » ferait
 * disparaître d'un écran une relecture qui, elle, a bien eu lieu.
 *
 * `null` quand rien n'a été relu — et un travail sans relecture se conclut
 * comme avant.
 */
export function lastReviewVerdict(views: readonly { verdict: string | null }[]): string | null {
  for (let i = views.length - 1; i >= 0; i -= 1) {
    const v = views[i]?.verdict;
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}
