// review-state.ts — CE QUE LA RELECTURE A DIT EN DERNIER, lu une fois pour les
// trois écrans qui concluent un travail (#59).
//
// Un travail peut porter plusieurs verdicts : le sien, celui d'un délégué
// relecteur, une seconde passe après correction. C'est le DERNIER qui compte, et
// il n'y a qu'un endroit où ce « dernier » se choisit : ici.
//
// Ce que l'écran en fait a changé le 19/09 au soir, après que le propriétaire a
// vu le bloc sur la stack : un `request_changes` ne retire plus le mot
// « Delivered », il s'affiche à côté. Un run relu a livré quelque chose, et le
// nier revenait à dire que le travail n'avait pas eu lieu. Ce module, lui, n'a
// pas bougé — il rend un fait, pas une décision.
//
// Module PUR : il ne lit ni la base ni le réseau, il range une liste déjà lue.
// La règle qui LIT ce fait (`reviewBlocksDelivery`) vit dans
// `@nodal-agents/shared`, où l'orchestration la lit aussi pour poser le champ
// typé que reçoit le parent.

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
