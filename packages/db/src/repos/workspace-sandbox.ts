// repos/workspace-sandbox.ts — lire et écrire le réglage du bac à sable d'un
// espace (#876).
//
// LE SEUL point qui lit ces deux colonnes. Le runner y passe à CHAQUE
// lancement confiné (`run_command`, `run_skill_script`, les commandes de
// preuve, les programmes de Nodal comme git) — jamais une valeur gardée depuis
// la sonde : couper ou rallumer prend effet à la commande suivante, sans
// redémarrer.
//
// Ne rattrape RIEN (invariant #4, même leçon que verification-surfaces.ts) :
// une entité introuvable ou une colonne illisible LÈVE avec le code
// `SANDBOX_SETTINGS_UNREADABLE`. Un `catch` qui rendrait « allumé » cacherait
// une base cassée ; un `catch` qui rendrait « éteint » ouvrirait la machine.

import { eq } from 'drizzle-orm';
import {
  SANDBOX_SETTINGS_UNREADABLE,
  parseSandboxFolders,
  type SandboxFolders,
  type WorkspaceSandbox,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { workspaceOfScope, type WorkspaceScope } from '../queries/workspace-scope.ts';
import { entities } from '../schema/index.ts';

/** Le réglage de l'espace `entityId`. Lève `SANDBOX_SETTINGS_UNREADABLE: …` sinon. */
export async function readWorkspaceSandbox(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<WorkspaceSandbox> {
  return readSandboxRow(db, entityId, false);
}

/**
 * La ligne du réglage, parsée. `lock` la prend en `FOR UPDATE` : un autre geste
 * sur la même ligne attend la fin de la transaction qui la tient.
 */
async function readSandboxRow(
  db: AnyDrizzleDb,
  entityId: string,
  lock: boolean,
): Promise<WorkspaceSandbox> {
  let row: { enabled: unknown; folders: unknown } | undefined;
  try {
    const query = db
      .select({ enabled: entities.sandboxEnabled, folders: entities.sandboxFolders })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    [row] = await (lock ? query.for('update') : query);
  } catch (err) {
    throw new Error(
      `${SANDBOX_SETTINGS_UNREADABLE}: the workspace settings could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
      { cause: err },
    );
  }
  if (!row) throw new Error(`${SANDBOX_SETTINGS_UNREADABLE}: workspace ${entityId} not found`);
  if (typeof row.enabled !== 'boolean') {
    throw new Error(`${SANDBOX_SETTINGS_UNREADABLE}: sandbox_enabled is not a boolean`);
  }
  return { enabled: row.enabled, folders: parseSandboxFolders(row.folders) };
}

/**
 * Le LECTEUR du réglage de l'espace, tel que le bac à sable le prend
 * (`ConfinementPolicy.workspace`, `withNodalPrograms`) : une fonction que le
 * lanceur appelle à chaque commande ou session, jamais une valeur gardée.
 * Le seul constructeur du dépôt : chaque appelant qui lance pour un espace
 * passe par lui.
 *
 * L'espace est donné tel quel, ou par le TRAVAIL qui lance (`WorkspaceScope`) :
 * le sien, sinon celui de son agent — la règle unique de `workspaceOfScope`. Un
 * job créé sans espace par un appelant interne relève donc de l'espace de son
 * agent, pour ses commandes comme pour ses handles. Aucun des deux : le
 * lecteur LÈVE `SANDBOX_SETTINGS_UNREADABLE`, jamais un réglage supposé.
 */
export function workspaceSandboxReader(
  db: AnyDrizzleDb,
  workspace: string | WorkspaceScope,
): () => Promise<WorkspaceSandbox> {
  return async () => {
    const entityId =
      typeof workspace === 'string' ? workspace : await workspaceOfScope(db, workspace);
    if (!entityId) {
      throw new Error(
        `${SANDBOX_SETTINGS_UNREADABLE}: agent ${
          typeof workspace === 'string' ? '' : (workspace.agentId ?? '')
        } belongs to no workspace`,
      );
    }
    return readWorkspaceSandbox(db, entityId);
  };
}

/** Pose l'interrupteur de l'espace. Les droits sont vérifiés par l'appelant. */
export async function setWorkspaceSandboxEnabled(
  db: AnyDrizzleDb,
  entityId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(entities)
    .set({ sandboxEnabled: enabled, updatedAt: new Date() })
    .where(eq(entities.id, entityId));
}

/**
 * UN geste de l'utilisateur sur la liste des dossiers permis (#876) :
 *   - `add` : permettre un dossier. Un dossier détecté qu'il avait retiré est
 *     rétabli ; un dossier déjà ajouté ne change rien. `awaitsConfirmation` :
 *     l'ajout attend une confirmation que l'écran n'a pas encore apportée
 *     (`broadFolder`), et n'écrit rien tant qu'il l'attend ;
 *   - `remove` : un ajout est oublié, un dossier détecté est noté retiré ;
 *   - `restore` : un dossier détecté retiré est rétabli.
 */
export type SandboxFolderGesture =
  | { readonly op: 'add'; readonly path: string; readonly awaitsConfirmation: boolean }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'restore'; readonly path: string };

/** Ce qu'un geste a fait. `already-allowed`, `needs-confirmation`, `unchanged` : rien d'écrit. */
export type SandboxFolderOutcome =
  | 'added'
  | 'restored'
  | 'already-allowed'
  | 'needs-confirmation'
  | 'forgotten'
  | 'removed'
  | 'unchanged';

/**
 * Le geste appliqué à des gestes déjà posés, sans toucher à la base.
 * `folderKey` dit quand deux chemins sont le même dossier : celle de la
 * composition (`folderKey`, @nodal-agents/sandbox), que l'appelant passe —
 * la base ne décide pas seule de ce qu'est un même dossier sur ce système.
 */
export function applySandboxFolderGesture(
  folders: SandboxFolders,
  gesture: SandboxFolderGesture,
  folderKey: (path: string) => string,
): { folders: SandboxFolders; outcome: SandboxFolderOutcome } {
  const k = folderKey(gesture.path);
  const has = (list: readonly string[]) => list.some((p) => folderKey(p) === k);
  const without = (list: readonly string[]) => list.filter((p) => folderKey(p) !== k);
  switch (gesture.op) {
    case 'add':
      if (has(folders.removed)) {
        return { folders: { ...folders, removed: without(folders.removed) }, outcome: 'restored' };
      }
      if (has(folders.added)) return { folders, outcome: 'already-allowed' };
      if (gesture.awaitsConfirmation) return { folders, outcome: 'needs-confirmation' };
      return { folders: { ...folders, added: [...folders.added, gesture.path] }, outcome: 'added' };
    case 'remove':
      if (has(folders.added)) {
        return { folders: { ...folders, added: without(folders.added) }, outcome: 'forgotten' };
      }
      if (has(folders.removed)) return { folders, outcome: 'unchanged' };
      return {
        folders: { ...folders, removed: [...folders.removed, gesture.path] },
        outcome: 'removed',
      };
    case 'restore':
      if (!has(folders.removed)) return { folders, outcome: 'unchanged' };
      return { folders: { ...folders, removed: without(folders.removed) }, outcome: 'restored' };
  }
}

/**
 * Applique UN geste au réglage de l'espace, atomiquement : la ligne est lue
 * en `FOR UPDATE`, le geste appliqué, le résultat validé puis écrit, dans la
 * même transaction. Deux gestes simultanés s'attendent et arrivent tous les
 * deux : un retrait ne disparaît jamais sous un ajout, ce qui rouvrirait le
 * dossier sans un mot. C'est la seule écriture du dépôt sur cette colonne ;
 * aucune ne la remplace entière à partir d'une lecture faite avant.
 *
 * La valeur est validée AVANT d'être écrite : la base ne reçoit jamais ce que
 * `readWorkspaceSandbox` refuserait de relire. Un réglage illisible fait
 * échouer le geste, nommé (`SANDBOX_SETTINGS_UNREADABLE`). Les droits sont
 * vérifiés par l'appelant.
 */
export async function changeWorkspaceSandboxFolders(
  db: AnyDrizzleDb,
  entityId: string,
  gesture: SandboxFolderGesture,
  folderKey: (path: string) => string,
): Promise<SandboxFolderOutcome> {
  return db.transaction(async (tx) => {
    const current = await readSandboxRow(tx as unknown as AnyDrizzleDb, entityId, true);
    const next = applySandboxFolderGesture(current.folders, gesture, folderKey);
    if (next.folders !== current.folders) {
      await tx
        .update(entities)
        .set({ sandboxFolders: parseSandboxFolders(next.folders), updatedAt: new Date() })
        .where(eq(entities.id, entityId));
    }
    return next.outcome;
  });
}
