// exclusive-create.ts — créer un fichier SEULEMENT s'il n'y a rien à ce chemin,
// lien compris, sur tous les systèmes.
//
// POURQUOI PAS `writeFile(path, data, { flag: 'wx' })`. `wx` (O_CREAT | O_EXCL)
// refuse un chemin qui existe déjà, lien symbolique pendant compris, sous
// Linux et macOS : O_EXCL ne suit jamais un lien. Sous Windows, il le SUIT : un
// `.gitignore` planté comme lien vers un fichier absent est ouvert en
// CREATE_NEW sur la cible, qui n'existe pas, donc créée — le serveur hôte écrit
// alors hors du dossier que des commandes confinées contrôlent (mesuré sur le
// runner Windows Server de la CI, project-git.test.ts, 16/10/2026).
//
// LA FORME QUI TIENT PARTOUT. Le contenu est écrit sous un nom que personne ne
// peut deviner (création exclusive, donc rien à suivre), puis rattaché au chemin
// voulu par un lien en dur : `link()` crée une entrée de dossier, ne suit
// jamais la destination, et échoue EEXIST si quoi que ce soit — fichier,
// dossier, lien pendant — s'y trouve déjà. Un seul geste atomique, aucune
// fenêtre entre « tester » et « écrire ».
//
// Un système de fichiers sans liens en dur (FAT, certains partages réseau)
// fait échouer l'appel avec l'erreur de `link()` : pas de repli sur une écriture
// qui suivrait un lien (invariant #4).

import { randomBytes } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';

/**
 * Crée `path` avec `data` s'il n'y a rien à ce chemin. Rejette avec `EEXIST`
 * sinon (le contenu existant n'est pas touché), et ne suit jamais un lien posé
 * à `path`.
 */
export async function createFileExclusive(path: string, data: string | Uint8Array): Promise<void> {
  const staged = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(staged, data, { flag: 'wx' });
  try {
    await link(staged, path);
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}
