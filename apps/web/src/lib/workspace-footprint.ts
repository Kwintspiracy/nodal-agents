// workspace-footprint.ts — LES PHRASES de la taille d'un espace et de sa
// dernière photo de sécurité (#261).
//
// Pur, et dans son propre module : la lecture vit dans
// `workspace-footprint-actions.ts`, qui porte `'use server'` et ouvre
// `node:fs`. Un composant client ne peut pas l'importer, et une phrase écrite
// en ligne dans le rendu ne se testerait qu'à travers un DOM.
//
// CE QUE CES PHRASES NE FONT JAMAIS :
//
//   elles n'arrondissent pas un plancher en une taille. Quand le comptage
//   s'est arrêté avant la fin (`capped`), la phrase commence par « at least » —
//   le chiffre est alors un minorant, et l'écrire nu ferait croire que le
//   dossier ne pèse pas plus ;
//
//   elles ne rendent jamais un zéro pour une absence. Un dossier qui n'existe
//   pas, un dossier illisible et une photo jamais chronométrée ont chacun leur
//   phrase. Zéro est un FAIT — « ce dossier est vide » — et pas l'aveu qu'on ne
//   sait pas (invariant #4).

import type { WorkspaceFootprint } from './workspace-footprint-actions.ts';

/**
 * Ce que pèse le dossier partagé de cet espace, en une phrase.
 *
 * `null` en entrée = la lecture n'a pas encore répondu ; l'écran dit alors
 * qu'il mesure, ce qui n'est pas la même chose qu'un dossier vide.
 */
export function footprintSizeText(footprint: WorkspaceFootprint): string {
  if (footprint.measure === null) {
    return footprint.unmeasured === 'absent' ? 'No shared folder yet' : 'Size unreadable';
  }
  const { sizeLabel, files, capped } = footprint.measure;
  const fichiers = files === 1 ? '1 file' : `${files} files`;
  // « at least » porte sur les DEUX chiffres : le comptage s'est arrêté, donc
  // ni la taille ni le nombre de fichiers ne sont complets.
  return capped ? `At least ${sizeLabel} in ${fichiers}` : `${sizeLabel} in ${fichiers}`;
}

/**
 * Combien de temps a pris la dernière photo de sécurité, en une phrase.
 *
 * Le seuil de `git add` est de 30 secondes, et c'est vers lui que cette durée
 * monte. La phrase donne la durée, pas un verdict : dire « heavy » demanderait
 * un seuil que rien ici ne connaît, et qui serait faux sur une autre machine.
 */
export function footprintSnapshotText(footprint: WorkspaceFootprint): string {
  const photo = footprint.lastSnapshot;
  if (photo === null) return 'No safety snapshot yet';
  if (photo.ms === null) return 'Last snapshot not timed';
  // Sous la seconde, les millisecondes ; au-delà, une décimale — c'est la
  // précision utile quand on regarde une durée approcher trente secondes.
  const duree = photo.ms < 1000 ? `${photo.ms} ms` : `${(photo.ms / 1000).toFixed(1)} s`;
  return `Last snapshot took ${duree}`;
}
