// verification/produced.ts — « un outil a RÉUSSI à écrire dans ce livrable ».
//
// LE CONTRAT, et ce qu'il n'est PAS. `addressed` dit ce qu'un outil a NOMMÉ ;
// il est écrit AVANT l'exécution, avec l'intention de mutation, et une
// tentative qui échoue le laisse en place. C'est voulu : une preuve doit être
// invalidée par ce qui a été TENTÉ, pas seulement par ce qui a réussi.
//
// `produced` répond à l'autre question, et une seule chose s'en sert :
// `declare_verification`, pour savoir si ce job a le droit de dire comment on
// vérifie ce projet. Confondre les deux laissait un `file_edit` au `old_string`
// absent — donc sans la moindre écriture — autoriser la déclaration, et donc le
// remplacement d'une séquence que le propriétaire avait approuvée (revue Codex,
// PR #49, passe 2).
//
// POURQUOI IL NE LÈVE JAMAIS. Comme le registre des projets, il est appelé
// depuis le seam d'exécution, APRÈS l'écriture et hors du try/catch : une
// exception ici tuerait la boucle du job pour une écriture qui a parfaitement
// eu lieu. Une panne se DIT par un code (invariant #4) et se termine en
// `false` — l'agent devra déclarer sa preuve autrement, ce qui est le sens
// conservateur.
//
// INVARIANT #2 : tout ce que ce module journalise est un CODE et des données.

import { jobDeliverableVerificationState, and, eq, inArray } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DeliverableType } from '@nodal-agents/shared';
import type { DirtiedDeliverable } from './intent';

/**
 * Marque `produced` sur les livrables que l'outil a NOMMÉS, et sur eux seuls.
 *
 * Les livrables de PRÉCAUTION sont écartés : ils entrent dans le périmètre
 * parce qu'un shell peut écrire n'importe où, pas parce que ce travail les a
 * produits. Les compter ici rendrait à `declare_verification` exactement le
 * pouvoir qu'on vient de lui retirer — déclarer pour un dossier voisin.
 *
 * Rend `true` si au moins une ligne a été marquée. Aucun appelant n'en dépend
 * aujourd'hui ; c'est ce qui rend la panne observable en test plutôt que muette.
 */
export async function markDeliverablesProduced(
  db: AnyDrizzleDb,
  jobId: string,
  deliverables: readonly DirtiedDeliverable[],
  /**
   * Les clés qu'une écriture CONSTATÉE soutient (issue #60, `observed.ts`).
   * Un livrable nommé mais dont aucun fichier n'a changé sur le disque n'est
   * pas produit — et c'est dit par un code. Omis = tout ce qui est nommé
   * (l'ancien contrat, gardé pour les appelants qui n'observent pas).
   */
  observedKeys?: ReadonlySet<string>,
): Promise<boolean> {
  const nommes = deliverables.filter((d) => d.addressed);
  if (!jobId || nommes.length === 0) return false;

  const nonConstates = observedKeys ? nommes.filter((d) => !observedKeys.has(d.key)) : [];
  if (nonConstates.length > 0) {
    console.warn(
      `[verification] VERIFICATION_PRODUCED_NOT_OBSERVED job=${jobId} ` +
        `keys=${nonConstates.map((d) => `${d.deliverableType}:${d.key}`).join(',')}`,
    );
  }
  const constates = observedKeys ? nommes.filter((d) => observedKeys.has(d.key)) : nommes;
  if (constates.length === 0) return false;

  // Un UPDATE par TYPE : la clé d'unicité est (job, type, clé), et mélanger
  // les types dans un seul `inArray` de clés marquerait un office_file qui
  // partagerait par hasard la clé d'un projet.
  const parType = new Map<DeliverableType, string[]>();
  for (const d of constates) {
    const bucket = parType.get(d.deliverableType);
    if (bucket) bucket.push(d.key);
    else parType.set(d.deliverableType, [d.key]);
  }

  let marques = 0;
  for (const [deliverableType, keys] of parType) {
    try {
      const rows = await db
        .update(jobDeliverableVerificationState)
        .set({ produced: true, updatedAt: new Date() })
        .where(
          and(
            eq(jobDeliverableVerificationState.jobId, jobId),
            eq(jobDeliverableVerificationState.deliverableType, deliverableType),
            inArray(jobDeliverableVerificationState.canonicalKey, keys),
          ),
        )
        .returning({ id: jobDeliverableVerificationState.id });
      marques += rows.length;
    } catch (err) {
      console.error(
        `[verification] VERIFICATION_PRODUCED_MARK_FAILED job=${jobId} type=${deliverableType} ` +
          `count=${keys.length} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return marques > 0;
}
