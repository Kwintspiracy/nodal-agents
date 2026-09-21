// verification-repairs.ts — ce qu'une preuve REJOUÉE change pour les écrans
// (issue #375).
//
// Depuis que le runner rouvre un run sur une preuve rouge pour un tour de
// réparation, un même job peut prouver DEUX fois le même livrable : la
// séquence qui a rougi, et celle qui a suivi la correction. Les trois écrans
// qui comptent les commandes et concluent « Proof passed » ou « Proof failed »
// les additionnaient. Le résultat se lisait à l'envers d'un run parfaitement
// vert : « 1 / 2 » et « Proof failed », alors qu'une seule commande existe et
// qu'elle passe.
//
// CE QUE CE MODULE RETIRE, ET RIEN D'AUTRE : le doublon qu'une réparation
// crée. L'identité d'une preuve est donc le QUADRUPLET
// (job, type de livrable, clé canonique, origine) :
//
//   le JOB, parce qu'un délégué qui prouve le même projet que sa tête a
//   prouvé quelque chose de son côté — l'effacer ferait disparaître de
//   l'encart une preuve que personne n'a rejouée (Reviewer C, PR #389) ;
//   l'ORIGINE, pour la même raison, entre un relecteur et le travail.
//
// Une réparation, elle, rejoue le MÊME job sur le MÊME livrable avec la MÊME
// origine : c'est exactement, et uniquement, ce que le filtre replie.
//
// Ce module est PUR : `CodeProcessDetail` est un composant client, et le
// détail de la page Code passe par ici. La lecture en base des tours de
// réparation vit à côté, dans `verification-repairs-read.ts`, sous
// `server-only`.

/** Ce qu'une preuve doit porter pour qu'on sache DE QUI et DE QUOI elle parle. */
export interface ProofIdentity {
  readonly jobId: string | null;
  readonly deliverableType: string;
  readonly canonicalKey: string;
  /** `'job'` (le travail lui-même) ou `'reviewer'` (un relecteur mandaté). */
  readonly source: string;
  readonly sequenceId: string;
}

const identite = (row: ProofIdentity): string =>
  JSON.stringify([row.jobId, row.deliverableType, row.canonicalKey, row.source]);

/**
 * Le cœur : par identité de preuve, ne garder que la séquence la plus récente,
 * dans l'ordre d'entrée.
 *
 * À égalité de date, l'ordre d'arrivée tranche — deux séquences de la même
 * identité écrites à la même milliseconde n'existent pas (une preuve dure au
 * moins un spawn), mais le tri doit rester total pour que l'écran ne clignote
 * pas d'un rendu à l'autre.
 */
function derniereParIdentite<T extends ProofIdentity>(
  rows: readonly T[],
  quand: (row: T) => number,
): T[] {
  const gagnante = new Map<string, { sequenceId: string; at: number; rang: number }>();
  rows.forEach((row, rang) => {
    const cle = identite(row);
    const at = quand(row);
    const tenante = gagnante.get(cle);
    if (tenante === undefined || at > tenante.at || (at === tenante.at && rang > tenante.rang)) {
      gagnante.set(cle, { sequenceId: row.sequenceId, at, rang });
    }
  });
  return rows.filter((row) => gagnante.get(identite(row))?.sequenceId === row.sequenceId);
}

/**
 * Les LIGNES de `verification_runs`, une par commande : ne garder que celles
 * de la dernière séquence de chaque preuve.
 *
 * `created_at` est `NOT NULL` en base et la lecture le rend tel quel : le type
 * l'exige ici plutôt que de porter une branche pour un cas que personne ne
 * peut produire (Reviewer C, PR #389).
 */
export function lastSequencePerDeliverable<T extends ProofIdentity & { readonly createdAt: Date }>(
  rows: readonly T[],
): T[] {
  return derniereParIdentite(rows, (row) => row.createdAt.getTime());
}

/**
 * Les SÉQUENCES déjà groupées — ce que le détail de la page Code manipule.
 * Même règle, même identité ; seule la date change de nom et de forme
 * (`startedAt`, une chaîne ISO).
 */
export function lastSequenceViewPerDeliverable<
  T extends ProofIdentity & { readonly startedAt: string },
>(sequences: readonly T[]): T[] {
  return derniereParIdentite(sequences, (s) => Date.parse(s.startedAt));
}
