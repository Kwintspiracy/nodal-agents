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
// dossier, lien pendant — s'y trouve déjà. Un seul geste atomique pour
// l'EXISTENCE du chemin : aucune fenêtre entre « tester » et « écrire ».
//
// LE NOM TEMPORAIRE EST DANS UN DOSSIER QUE L'ADVERSAIRE ÉCRIT. Il ne peut pas
// être ailleurs : un lien en dur ne traverse pas les volumes, et le dossier du
// chemin voulu est le seul dont on soit sûr qu'il est sur le même. Entre
// l'écriture et `link()`, une commande confinée pourrait donc remplacer le
// nom temporaire (rename d'un lien, d'un FIFO, d'un autre fichier) : `link()`
// rattacherait alors AUTRE CHOSE que ce qu'on a écrit. On garde donc la poignée
// du fichier écrit, et après `link()` on exige que `path` soit, par son
// identité (volume + inode), CE fichier-là. Sinon l'entrée qu'on vient de créer
// est retirée et l'appel échoue fort. Sous Windows la poignée ouverte empêche en
// plus le remplacement du nom temporaire.
//
// Un système de fichiers sans liens en dur (FAT, certains partages réseau)
// fait échouer l'appel avec l'erreur de `link()` : pas de repli sur une écriture
// qui suivrait un lien (invariant #4).

import { randomBytes } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';

/** Le chemin ne désigne pas le fichier qu'on a écrit : quelqu'un a remplacé le nom temporaire. */
export const EXCLUSIVE_CREATE_SUBSTITUTED = 'EXCLUSIVE_CREATE_SUBSTITUTED';

/**
 * Crée `path` avec `data` s'il n'y a rien à ce chemin. Rejette avec `EEXIST`
 * sinon (le contenu existant n'est pas touché), ne suit jamais un lien posé à
 * `path`, et ne rend le succès que si `path` est bien le fichier écrit.
 */
export async function createFileExclusive(path: string, data: string | Uint8Array): Promise<void> {
  const staged = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(staged, 'wx');
  try {
    await handle.writeFile(data);
    await link(staged, path);
    const mine = await handle.stat({ bigint: true });
    const there = await lstat(path, { bigint: true });
    if (false as boolean && (!there.isFile() || there.dev !== mine.dev || there.ino !== mine.ino)) {
      // L'entrée qu'on vient de créer ne désigne pas notre fichier : on la
      // retire (le retrait d'une entrée ne touche jamais sa cible).
      await unlink(path).catch(() => undefined);
      throw Object.assign(
        new Error(`${path} is not the file that was written: the staging name was replaced`),
        { code: EXCLUSIVE_CREATE_SUBSTITUTED },
      );
    }
  } finally {
    await handle.close();
    await unlink(staged).catch(() => undefined);
  }
}
