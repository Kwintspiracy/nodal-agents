// project-listing.ts — LA RÈGLE, écrite UNE fois : qu'est-ce qu'un projet LISTÉ.
//
// Elle vivait en deux endroits qui décidaient chacun de leur côté (#364) : la
// requête de la barre latérale écartait les masqués, celle de la page les
// rendait tous, et la page les dessinait. Deux écrans disaient donc deux choses
// du même geste — « Remove from list » retirait de la barre, puis renvoyait sur
// une page qui montrait le projet retiré.
//
// Un projet listé, c'est DEUX faits et pas un :
//   1. il est DÉCLARÉ — `registered_at IS NOT NULL` ; sans cela c'est une ligne
//      de comptabilité née d'un renommage ou d'une écriture d'agent ;
//   2. il n'a pas été RETIRÉ de la liste — `hidden = false`.
//
// Deux formes du même prédicat, parce qu'une liste se filtre à deux moments :
// `listedProjectsWhere` pour la requête qui ne veut QUE les listés (la barre),
// `isListedProject` pour un écran qui lit TOUT (la page les montre derrière
// « Hidden »). Les deux lisent les mêmes colonnes, ici, côte à côte : c'est ce
// qui les empêche de diverger.

import { and, eq, isNotNull, codeProjects, excludedProjectPaths } from '@nodal-agents/db';

/** La valeur de `hidden` d'un projet qui se liste. */
const HIDDEN_LISTED = false;

/**
 * Au REGISTRE : déclaré par quelqu'un, pour cette entité. Ce que la page lit —
 * les masqués compris, qu'elle range dans sa section « Hidden ».
 */
export function registeredProjectsWhere(entityId: string) {
  return and(eq(codeProjects.entityId, entityId), isNotNull(codeProjects.registeredAt));
}

/** LISTÉ : au registre, et pas retiré de la liste. Ce que la barre lit. */
export function listedProjectsWhere(entityId: string) {
  return and(registeredProjectsWhere(entityId), eq(codeProjects.hidden, HIDDEN_LISTED));
}

/** La MÊME règle, sur une ligne déjà lue — la part que la page applique. */
export function isListedProject(row: { hidden: boolean }): boolean {
  return row.hidden === HIDDEN_LISTED;
}

// ─── Les dossiers ÉCARTÉS (#385) ─────────────────────────────────────────────
//
// La liste ne vient pas que du registre : un dossier où un agent a écrit y
// paraît aussi, marqué « Detected », sans avoir de ligne à lui. Oublier un
// projet (#371) supprimait sa ligne de registre, et la détection le ramenait
// aussitôt — le geste ne tenait pas.
//
// L'exclusion est donc la TROISIÈME part de la même règle, et elle est écrite
// ici, à côté des deux autres, pour la même raison : deux endroits qui
// décideraient chacun de leur côté finiraient par dire deux choses.
//
// Elle ne porte QUE sur la détection. Un dossier écarté qu'on ré-enregistre
// devient un projet du registre, et un projet du registre se liste — sinon
// l'exclusion masquerait en silence un projet que quelqu'un vient de déclarer
// (invariant #4). C'est aussi pourquoi `register_project` retire la ligne.

/** Les dossiers ÉCARTÉS de cet espace. Une seule lecture, jamais une par ligne. */
export function excludedPathsWhere(entityId: string) {
  return eq(excludedProjectPaths.entityId, entityId);
}

/**
 * ÉCARTÉ : ce que la détection ne propose plus.
 *
 * Par CLÉ d'identité (`projectKey`), jamais par égalité de texte sur le chemin
 * — sous Windows le même dossier remonte avec des casses différentes selon la
 * session, et une comparaison de texte laisserait passer la moitié des cas.
 */
export function isExcludedPath(key: string, excludedKeys: ReadonlySet<string>): boolean {
  return excludedKeys.has(key);
}
