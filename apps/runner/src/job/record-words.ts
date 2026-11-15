// job/record-words.ts — les mots du cadre que le runner pose dans le relevé
// d'un échange (#1075, #1101), et nulle part ailleurs.
//
// Le relevé est LU PAR LE MODÈLE comme « voici ce qui s'est passé » (#1101) :
// ses mots décident de ce qu'un agent dit ensuite à la personne. Constat en
// usage réel, le 14/11 : le relevé d'une tâche encore en cours citait une
// première tentative ratée qu'elle refaisait déjà, et la personne s'est
// entendu dire qu'il y avait « un problème avec l'image ».
//
// Chaque mot du cadre vit ICI, une fois : le relevé est rebâti sur de vrais
// échanges et rejoué sur le modèle en service, et une formulation se mesure
// en changeant cet objet, rien d'autre (`exchangeRecordLines` le prend en
// paramètre, celui-ci par défaut).
//
// Ce qui n'y est PAS, mesuré le 15/11 sur le modèle en service : une note de
// coupe devant une citation coupée (`(cut)`, `(first 195 of 400 characters)`).
// Sur un vrai suivi d'impression, cinq réponses par variante, aucune n'a dit
// la citation incomplète ; le modèle lit les mots qui sont là. Elle coûtait
// +2,8 % de jetons par tour pour rien de mesurable : elle est retirée, et la
// coupe tombe entre deux mots (`quoteAtBound`).
//
// Invariant #2 : ce sont des mots du cadre de la plateforme, lus par le
// modèle, jamais par la personne. Ce qu'un outil a dit est cité, comme une
// donnée, APRÈS la flèche ; les mots du runner sont AVANT, où un texte rangé
// ne peut pas les imiter.

/** Une ligne de citation : l'outil, son compte, ce que le runner en dit, et la citation. */
export interface QuoteLineParts {
  /** Le nom de l'outil, déjà à sa borne. */
  name: string;
  /** Combien d'appels identiques cette ligne dit (`×N` au-delà de un). */
  count: number;
  /** Ce que le runner dit de l'appel (son issue), dans cet ordre. */
  notes: readonly string[];
  /** Ce que l'appel a rendu, tel que cité. */
  head: string;
}

export interface RecordWords {
  /** L'en-tête d'un échange terminé : les outils appelés. */
  actions: (names: string) => string;
  /**
   * Le relevé ENTIER d'un job qui n'a pas fini : les outils appelés jusque-là,
   * et rien de ce qu'ils ont rendu (#1101).
   */
  running: (names: string) => string;
  /** Les citations les plus anciennes tombées sous la borne, comptées. */
  notQuoted: (n: number) => string;
  /** Un appel dont l'issue rangée est un échec, que rien n'a refait ensuite. */
  failed: string;
  /** Un appel réussi qui refait `n` échecs du même outil, comptés et non cités. */
  redone: (n: number) => string;
  /** La ligne d'une citation. */
  quoteLine: (parts: QuoteLineParts) => string;
}

export const RECORD_WORDS: RecordWords = {
  actions: (names) => `[Actions performed in this exchange: ${names}]`,
  running: (names) =>
    `[Not ended yet. Tools called so far: ${names}. What they returned is not final and is not quoted here.]`,
  notQuoted: (n) => `[${n} earlier tool results not quoted]`,
  failed: 'failed',
  redone: (n) => (n === 1 ? 'after 1 failed attempt' : `after ${n} failed attempts`),
  quoteLine: ({ name, count, notes, head }) =>
    `${name}${count > 1 ? ` ×${count}` : ''}${notes.length > 0 ? ` (${notes.join('; ')})` : ''} → ${head}`,
};
