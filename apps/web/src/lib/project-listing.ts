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

import { and, eq, isNotNull, codeProjects } from '@nodal-agents/db';

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
