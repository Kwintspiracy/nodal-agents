// file-ops/atomic-write.ts — l'écriture atomique des outils qui écrivent un
// fichier entier (file_write, file_edit, generate_speech), à UN endroit
// (issue #505, revue Codex passe 2).
//
// Deux choses ne pouvaient être vraies qu'ici, au plus près de l'écriture :
//
//  1. L'EMPREINTE DE CE QUI EST ÉCRIT. La porte d'écrasement du dossier
//     partagé laisse un run réécrire le fichier qu'il a lui-même produit, et
//     elle le prouve par l'empreinte du contenu. Relire le disque après coup
//     attribuait au job ce qu'un autre écrivain avait pu poser entre-temps :
//     l'empreinte est donc celle des OCTETS que l'outil écrit, rapportée au
//     seam (`ctx.reportWrittenContent`), jamais une relecture.
//
//  2. LA DERNIÈRE VÉRIFICATION. La porte décide avant l'exécution ; un fichier
//     peut changer entre elle et le `rename`. Quand elle a laissé passer
//     l'appel sans personne (`ctx.sharedOverwriteUnattended`), la même
//     question est reposée juste avant de remplacer le fichier, et un fichier
//     qui n'est plus le nôtre n'est pas écrasé : l'appel est refusé, et le
//     rappeler passera par la porte, donc par la personne.
//
// LA LIMITE ASSUMÉE (revue Codex de #505, passe 3). Entre la lecture du
// contenu actuel et le `rename`, il reste une fenêtre : DEUX APPELS SYSTÈME
// CONSÉCUTIFS, la fin de la lecture du fichier (`fingerprint`, qui la fait en
// DERNIER, après la requête en base) et le `rename`, séparés seulement par
// le calcul synchrone de l'empreinte et le retour des promesses. Un écrivain
// qui ne coopère pas — une personne dans son éditeur, un autre processus — et
// qui écrit exactement dans cet intervalle voit son écriture remplacée. Aucun
// verrou multiplateforme ne la ferme : Windows, macOS et Linux n'offrent pas
// de verrou que cet écrivain respecterait, ni de « rename si inchangé »
// atomique. Elle n'est pas élargie : aucune entrée-sortie ne s'y glisse
// (`current-content-window.test.ts`).

import { createHash, randomBytes } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ToolContext } from '../../types';
import { computeSharedOverwriteApproval, WorkspaceError } from './workspace';

/**
 * Écrit `data` à `path` (déjà résolu) par un fichier temporaire du même
 * dossier renommé par-dessus la cible, puis rapporte l'empreinte des octets
 * écrits. Lève `WorkspaceError('shared_file_changed')` sans rien toucher si
 * la porte, reposée à l'instant, demanderait maintenant une personne.
 */
export async function writeFileAtomically(
  ctx: ToolContext,
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const tmp = `${dirname(path)}/.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, bytes);
    if (
      ctx.sharedOverwriteUnattended === true &&
      (await computeSharedOverwriteApproval(ctx, path)) === 'require_approval'
    ) {
      throw new WorkspaceError(
        'shared_file_changed',
        `Nothing was written: "${basename(path)}" in the shared folder changed since this call ` +
          `was allowed, and it is no longer content this run wrote. Call again: the owner will ` +
          `be asked before it is overwritten.`,
      );
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  ctx.reportWrittenContent?.(path, createHash('sha256').update(bytes).digest('hex'));
}
