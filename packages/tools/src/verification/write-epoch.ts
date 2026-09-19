// verification/write-epoch.ts — l'époque d'un projet monte AUSSI À L'ÉCRITURE,
// et pas seulement à l'intention (issue #101).
//
// LE TROU QUE CECI FERME. `finalize.ts` décide qu'une preuve est périmée en
// comparant l'époque du projet et son manifeste de part et d'autre de la
// preuve. Ces deux témoins ne voient rien de la séquence suivante, pourtant
// permise par le code :
//
//   1. B pose son intention et monte l'époque à 8 (`intent.ts`) ;
//   2. B attend son checkpoint — l'ÉCRITURE vient après (`execute.ts`) ;
//   3. A capture l'époque 8, puis prouve l'ANCIEN contenu ;
//   4. B écrit ;
//   5. A relit l'époque 8 et le même manifeste, et pose un VERT PÉRIMÉ.
//
// L'époque ne bouge plus parce que B l'a montée AVANT que A ne la capture ; le
// manifeste d'un projet de code ne décrit que sa CONFIGURATION de preuve (les
// commandes, le dossier, les versions de politique), jamais le contenu de son
// arbre, donc il est identique des deux côtés d'une écriture ; et la génération
// sale de A ne bouge pas non plus, puisque l'écriture n'est pas la sienne. Le
// vérificateur de DOCUMENTS a fermé sa moitié en #99 en rapportant ce que la
// preuve a réellement lu (`ProofResult.provedManifestHash`) — un projet de code
// n'a pas d'équivalent : sa preuve lance des commandes, et rien ne résume
// l'arbre sur lequel elles ont tourné.
//
// DEUX MONTÉES, DEUX RÔLES — rien n'est échangé. Celle de l'intention dit
// « quelqu'un s'APPRÊTE à écrire », et c'est pour cela qu'elle est posée avant :
// un CLI qui écrit puis sort non-zéro laisse le projet sale quand même. Celle-ci
// dit autre chose, que l'intention ne peut pas dire : « le disque VIENT
// peut-être de changer ». L'issue pesait « monter à l'écriture PLUTÔT QU'à
// l'intention » et refusait le troc, à juste titre ; ici la première montée
// reste en place, une seconde s'ajoute.
//
// POURQUOI PAS « COMPTER LES INTENTIONS OUVERTES » et refuser la preuve tant
// qu'il en reste. Il n'existe aucun signal d'intention OUVERTE en base :
// `produced` est ce qui s'en approche le plus, et il reste faux pour toujours
// sur une écriture qu'aucun constat ne crédite — une cible DOSSIER hors dépôt
// git n'en crédite aucune depuis #102, et une tentative qui échoue non plus.
// Une preuve différée sur ce critère ne repartirait jamais. Fermer le trou de
// correction en ouvrant un trou de disponibilité n'était pas le marché.
//
// CE QUI RESTE OUVERT, et c'est dit. L'écriture touche le disque et la montée
// touche la base : les deux ne peuvent pas être atomiques. Il reste donc la
// fenêtre d'UN `UPDATE`, entre le dernier octet écrit et la montée — là où il y
// avait jusqu'ici la durée entière de l'appel d'outil, qui se compte en minutes
// pour un harnais de code. La fermer complètement demanderait un marqueur
// « écriture en vol » posé à l'intention, relâché après l'écriture, avec son
// bail pour le runner qui meurt entre les deux, et une preuve qui ATTEND au
// lieu d'être déclarée périmée — un autre ticket, une autre forme.
//
// IL NE LÈVE JAMAIS, pour la même raison que `markDeliverablesProduced` : il est
// appelé depuis le seam, autour de `tool.execute`, donc DANS le `try` qui rend
// une erreur d'outil. Une exception ici rendrait un échec pour une écriture qui
// a parfaitement eu lieu. Une panne se DIT par un code (invariant #4).
//
// INVARIANT #2 : tout ce que ce module journalise est un CODE et des données.

import { codeProjects, and, eq, sql } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DirtiedDeliverable } from './intent';

/** La ligne `code_projects` attendue a disparu entre l'intention et l'écriture. */
export const WRITE_EPOCH_ROW_MISSING = 'VERIFICATION_WRITE_EPOCH_ROW_MISSING';
/** La montée d'époque n'a pas pu être écrite — la garde de péremption est aveugle sur ce projet. */
export const WRITE_EPOCH_BUMP_FAILED = 'VERIFICATION_WRITE_EPOCH_BUMP_FAILED';
/** Des livrables à faire vieillir, mais pas d'espace pour les retrouver. */
export const WRITE_EPOCH_NO_ENTITY = 'VERIFICATION_WRITE_EPOCH_NO_ENTITY';

/**
 * Monte `verification_epoch` des projets que CET appel vient d'écrire.
 *
 * Sur les MÊMES livrables que l'intention, périmètre de précaution compris :
 * un shell écrit où il veut, et c'est justement pour cela que l'intention a
 * sali tout son périmètre. Restreindre aux cibles NOMMÉES rouvrirait le trou
 * pour la seule surface qui en a le plus besoin.
 *
 * APPELÉ QUE L'ÉCRITURE AIT RÉUSSI OU NON — même contrat conservatif que
 * l'intention : une tentative qui a pu écrire à moitié a pu changer l'arbre, et
 * « il ne s'est peut-être rien passé » n'est pas une preuve qu'il ne s'est rien
 * passé.
 *
 * UNE LIGNE À LA FOIS, PAR CLÉ CROISSANTE, chacune dans sa propre transaction
 * implicite : cet appel ne tient donc jamais deux verrous à la fois et ne peut
 * pas s'interbloquer avec la passe ordonnée de l'intention
 * (`codeProjectLockOrder`). Les époques sont des compteurs monotones ; les
 * monter d'un seul geste atomique n'apporterait rien.
 *
 * Rend le nombre de lignes montées — jamais une erreur.
 */
export async function bumpEpochsAfterWrite(
  db: AnyDrizzleDb,
  entityId: string,
  deliverables: readonly DirtiedDeliverable[],
): Promise<number> {
  if (deliverables.length === 0) return 0;
  // Les appelants du runner construisent `entityId: job.entityId ?? ''` : une
  // entité vide ici veut dire qu'il y a des livrables à faire vieillir et
  // aucun espace pour les retrouver. Sortir sur un `return 0` muet laissait la
  // garde de péremption aveugle sans que rien ne le dise (invariant #4).
  if (!entityId) {
    console.error(
      `[verification] ${WRITE_EPOCH_NO_ENTITY} ` +
        `keys=${[...new Set(deliverables.map((d) => d.key))].join(',')}`,
    );
    return 0;
  }

  // `verificationEpoch !== null` est ce qui distingue un projet de code d'un
  // fichier bureautique : seuls les premiers ont une ligne `code_projects`, et
  // l'intention l'a déjà dit en posant cette valeur. Le relire ici évite de
  // recopier la liste des types qui verrouillent cette table — une deuxième
  // liste finirait par diverger.
  const keys = [
    ...new Set(deliverables.filter((d) => d.verificationEpoch !== null).map((d) => d.key)),
  ].sort();
  if (keys.length === 0) return 0;

  let montees = 0;
  for (const key of keys) {
    try {
      const rows = await db
        .update(codeProjects)
        .set({
          verificationEpoch: sql`${codeProjects.verificationEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(codeProjects.entityId, entityId), eq(codeProjects.projectKey, key)))
        .returning({ verificationEpoch: codeProjects.verificationEpoch });
      if (rows.length === 0) {
        // L'intention CRÉE la ligne si elle manque : ne plus la trouver signifie
        // qu'elle a été effacée entre les deux. Dit, jamais recréé ici — une
        // ligne recréée repartirait à l'époque 1 et RAJEUNIRAIT le projet.
        //
        // Le jumeau SANS JOB (`bumpEpochsAfterJoblessWrite`, intent.ts) fait
        // l'inverse, et c'est juste des deux côtés : lui n'a aucune intention
        // devant lui, donc au premier tour de chat sur un projet jamais sali la
        // ligne n'a jamais existé, et refuser de la créer reviendrait à ne rien
        // faire vieillir du tout. Son commentaire porte la règle en entier.
        console.warn(`[verification] ${WRITE_EPOCH_ROW_MISSING} entity=${entityId} key=${key}`);
        continue;
      }
      montees += rows.length;
    } catch (err) {
      // Pas de repli : sans cette montée, une preuve concurrente peut se croire
      // fraîche sur ce projet. On le dit fort plutôt que de le taire.
      console.error(
        `[verification] ${WRITE_EPOCH_BUMP_FAILED} entity=${entityId} key=${key} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return montees;
}
