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
// Ce que le relevé ne dit PAS, et pourquoi :
//  - aucune note de coupe : mesurée le 15/11 sur le modèle en service, elle ne
//    changeait pas ce qu'il lisait d'une citation coupée, et coûtait +2,8 % de
//    jetons par tour ;
//  - aucun verdict sur l'issue d'un appel (« échoué », « refait ») : le runner
//    ne range aucune issue d'appel sur laquelle s'appuyer, et qu'un appel en
//    « refasse » un autre est une intention qu'il ne peut pas connaître (revue
//    de #1106, passe 1). Les réponses sont citées, dans l'ordre, et le modèle
//    les lit.
//
// Invariant #2 : ce sont des mots du cadre de la plateforme, lus par le
// modèle, jamais par la personne. Ce qu'un outil a dit est cité, comme une
// donnée, APRÈS la flèche.

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
  /** La ligne d'une citation : l'outil, `×N` pour N citations identiques, ce qu'il a rendu. */
  quoteLine: (name: string, count: number, head: string) => string;
}

export const RECORD_WORDS: RecordWords = {
  actions: (names) => `[Actions performed in this exchange: ${names}]`,
  running: (names) =>
    `[Not ended yet. Tools called so far: ${names}. What they returned is not final and is not quoted here.]`,
  notQuoted: (n) => `[${n} earlier tool results not quoted]`,
  quoteLine: (name, count, head) => `${name}${count > 1 ? ` ×${count}` : ''} → ${head}`,
};
