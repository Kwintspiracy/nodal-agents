// project-path.ts — la règle du sous-dossier d'un projet, et le chemin qu'elle
// produit (plan « De la maquette au produit », P8).
//
// Module PUR, hors 'use server' : la modale « New project » doit montrer le
// chemin final PENDANT la saisie, et un module serveur ne se charge pas dans le
// navigateur. La règle vit donc ici, et `project-actions.ts` l'importe — un
// seul énoncé, jamais deux copies qui divergeront le jour où l'une se resserre.

import { normalizePath } from '@nodal-agents/shared';

/**
 * Le sous-dossier accepté : des segments RELATIFS, et rien d'autre.
 *
 * `''` est autorisé — le terrain lui-même devient le projet, ce qui est le cas
 * d'un dépôt attaché tel quel. Tout le reste est refusé plutôt que nettoyé :
 * aplatir `../evil` en `evil` serait accepter une demande en en exécutant une
 * autre, et l'utilisateur n'apprendrait jamais que sa saisie n'a pas été lue
 * telle qu'il l'a écrite.
 */
export function isSafeSubfolder(raw: string): boolean {
  if (raw === '') return true;
  const p = raw.replace(/\\/g, '/');
  // Un chemin ABSOLU ne se rattache à aucun terrain : `C:/…`, `/…`, `//srv/…`.
  if (/^[a-z]:/i.test(p) || p.startsWith('/')) return false;
  // Caractères de contrôle : illisibles à l'écran, ingérables sur le disque.
  if (/[\u0000-\u001f]/.test(p)) return false;
  const segments = p.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Le chemin que `createProjectAction` construirait, ou `null` si la saisie est
 * refusée.
 *
 * `null` plutôt qu'un chemin approximatif : montrer un aperçu pour une saisie
 * que l'action va rejeter promettrait un dossier qui ne sera jamais créé. La
 * modale affiche alors la règle, pas une destination.
 */
export function previewProjectPath(workspacePath: string, subfolder: string): string | null {
  if (!isSafeSubfolder(subfolder)) return null;
  const terrain = normalizePath(workspacePath);
  if (subfolder === '') return terrain;
  return normalizePath(`${terrain}/${subfolder.replace(/\\/g, '/')}`);
}
