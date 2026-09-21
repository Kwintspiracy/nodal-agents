// job-live.ts — UN TRAVAIL EST-IL ENCORE EN VIE ? (#252)
//
// La question se pose des DEUX CÔTÉS de la frontière : les pages d'un run, d'un
// fil et d'une session de code sont des composants SERVEUR et décident si elles
// dessinent une rangée d'actions ; le bouton, lui, est un composant CLIENT et
// se cache tout seul hors d'un statut vivant.
//
// ⚠️ ELLE NE PEUT DONC PAS VIVRE DANS `StopRunButton`. Elle y a vécu une heure,
// et les trois pages ont rendu 500 : « Attempted to call canStopRun() from the
// server but canStopRun is on the client ». Rien ne l'avait vu — ni le typage,
// ni le lint, ni les tests unitaires, qui montent les composants hors de la
// frontière React Server Components. Seule une VRAIE instance l'a dit.
//
// Ce module n'a donc pas de `'use client'`, et il n'importe rien qui en ait :
// c'est ce qui le rend lisible des deux côtés.

import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';

/**
 * Le travail est-il encore en vie, donc arrêtable ?
 *
 * DÉRIVÉ de la liste du produit (`LIVE_JOB_STATUSES`), jamais recopié : un
 * statut vivant ajouté demain devient arrêtable sans que personne y pense.
 *
 * Un statut absent ou inconnu n'est PAS vivant : une session de chat de la CLI
 * n'a pas de job, et on ne propose pas d'arrêter ce qu'on ne sait pas lire
 * (invariant #4).
 */
export function canStopRun(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  // La liste est typée sur les statuts connus ; le statut qui arrive ici vient
  // d'une colonne `text`. La comparaison se fait donc en chaînes.
  return (LIVE_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Ce qu'un travail vivant FAIT, pour le mot de l'encart de livraison (#337) :
 * `'working'` quand il tourne, `'waiting'` quand il est arrêté sur la personne
 * (une approbation), `null` quand il n'est plus vivant. Un run bloqué sur une
 * approbation ne travaille pas ; lui dessiner un spinner ferait lire un
 * travail actif là où rien ne bouge (Reviewer C, #337).
 */
export function liveKind(status: string | null | undefined): 'working' | 'waiting' | null {
  if (!canStopRun(status)) return null;
  return status === 'awaiting_approval' ? 'waiting' : 'working';
}
