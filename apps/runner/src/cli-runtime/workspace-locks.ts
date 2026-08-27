// cli-runtime/workspace-locks.ts — le créneau d'écriture unique d'une session
// CLI, sur TOUS ses dossiers.
//
// Le contrat existait déjà (un seul travail en écriture par dossier à la fois,
// partagé avec `code_task`), mais il ne portait que sur `cwd`. Dès que les
// dossiers secondaires ont été ouverts en écriture (`--add-dir`, 27/08), deux
// agents aux `cwd` différents mais partageant un dossier — typiquement le
// workspace PARTAGÉ, ajouté automatiquement à tout le monde — pouvaient écrire
// dans le même arbre en même temps. Le contrat ne tenait plus là où il compte
// le plus : à l'endroit que tous se partagent.
//
// Corrigé d'abord sur le chemin job, puis la revue suivante a trouvé le chemin
// chat resté en arrière — deux copies, un seul correctif appliqué. D'où ce
// fichier : une fois, pour les deux.

import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  WorkspaceLockedError,
  workspaceLockKey,
} from '@nodal-agents/tools';
import type { AnyDrizzleDb } from '@nodal-agents/db';

export { WorkspaceLockedError };

export interface HeldLocks {
  /** Rendre tous les verrous pris. Idempotent, et jamais bloquant. */
  release: () => Promise<void>;
}

/**
 * Prendre le créneau d'écriture sur chaque dossier, ou n'en garder aucun.
 *
 * L'ordre est STABLE (trié, dédupliqué) : deux sessions qui demandent les mêmes
 * dossiers les prennent dans le même ordre, donc l'une attend au lieu que les
 * deux se bloquent à mi-chemin.
 *
 * En cas de refus, ceux déjà pris sont RENDUS avant de relancer : une session
 * qui échoue en gardant des verrous bloquerait toutes les autres jusqu'à
 * expiration.
 */
export async function acquireWorkspaceLocks(
  db: AnyDrizzleDb,
  dirs: readonly string[],
  token: string,
  agentId: string,
): Promise<HeldLocks> {
  const held: string[] = [];
  const release = async (): Promise<void> => {
    for (const dir of held) {
      await releaseWorkspaceLock(db, dir, token).catch((err: unknown) => {
        console.warn(`[cli-runtime] workspace lock release failed (${dir}):`, err);
      });
    }
    held.length = 0;
  };

  // Dédupliqué par CLÉ DE VERROU, pas par chaîne brute.
  //
  // Le tour précédent a fait normaliser la clé côté base ; celle-ci restait
  // naïve. Un agent ayant le même dossier attaché deux fois sous deux
  // orthographes — `C:/Common` et `c:\common\` — voyait donc deux entrées ici,
  // prenait le verrou, puis se heurtait À LUI-MÊME sur la seconde : tout était
  // rendu et la session refusée en `workspace_locked` (revue Codex, 27/08). Le
  // correctif d'avant avait créé ce cas-là.
  //
  // On garde la première ORTHOGRAPHE rencontrée : elle sert aux messages, et la
  // clé normalisée est recalculée à la prise.
  const parCle = new Map<string, string>();
  for (const dir of dirs) {
    const cle = workspaceLockKey(dir);
    if (!parCle.has(cle)) parCle.set(cle, dir);
  }
  // Ordre STABLE sur la CLÉ : deux sessions demandant les mêmes dossiers écrits
  // différemment doivent quand même les prendre dans le même ordre.
  const ordonnes = [...parCle.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [, dir] of ordonnes) {
    try {
      await acquireWorkspaceLock(db, dir, token, agentId);
      held.push(dir);
    } catch (err) {
      await release();
      throw err;
    }
  }
  return { release };
}
