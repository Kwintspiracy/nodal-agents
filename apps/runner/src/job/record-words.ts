// job/record-words.ts — les mots du cadre que le runner pose dans le relevé
// d'un échange (#1075, #1101), et nulle part ailleurs.
//
// Le relevé est LU PAR LE MODÈLE comme « voici ce qui s'est passé » (#1101) :
// ses mots décident de ce qu'un agent dit ensuite à la personne. Deux
// constats en usage réel, le 14/11 : le relevé d'une tâche encore en cours
// citait une première tentative ratée qu'elle refaisait déjà (« un problème
// avec l'image »), et une citation coupée à 200 caractères, « (3
// impression(s)) », a été lue comme la réponse entière (« imprimé trois fois »).
//
// Chaque mot du cadre vit ICI, une fois : le relevé est rebâti sur de vrais
// échanges et rejoué sur le modèle en service, et une formulation se mesure
// en changeant cet objet, rien d'autre (`exchangeRecordLines` et
// `formatTaskLedgerEntry` le prennent en paramètre, celui-ci par défaut).
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
  /** Ce que le runner dit de l'appel (son issue, la coupe), dans cet ordre. */
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
  /** Une citation qui n'est pas la réponse entière : combien en est cité. */
  cut: (quoted: number, total: number) => string;
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
  cut: (quoted, total) => `first ${quoted} of ${total} characters`,
  quoteLine: ({ name, count, notes, head }) =>
    `${name}${count > 1 ? ` ×${count}` : ''}${notes.length > 0 ? ` (${notes.join('; ')})` : ''} → ${head}`,
};

/**
 * La place que prend la note de coupe d'un texte de `total` caractères, ses
 * séparateurs compris (` (`, `; `, `)`), au plus : `quoted` n'a jamais plus de
 * chiffres que `total`. Une citation coupée la prend sur sa propre borne
 * (#1101) : la dire ne coûte pas plus que la citation d'avant, mesurée à
 * +4,8 % de jetons par tour quand elle s'y ajoutait.
 */
export function cutNoteRoom(words: RecordWords, total: number): number {
  return words.cut(total, total).length + 3;
}
