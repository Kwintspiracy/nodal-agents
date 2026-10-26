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
import { entities } from '../schema/index.ts';

/** Le réglage de l'espace `entityId`. Lève `SANDBOX_SETTINGS_UNREADABLE: …` sinon. */
export async function readWorkspaceSandbox(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<WorkspaceSandbox> {
  let row: { enabled: unknown; folders: unknown } | undefined;
  try {
    [row] = await db
      .select({ enabled: entities.sandboxEnabled, folders: entities.sandboxFolders })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
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
 */
export function workspaceSandboxReader(
  db: AnyDrizzleDb,
  entityId: string,
): () => Promise<WorkspaceSandbox> {
  return () => readWorkspaceSandbox(db, entityId);
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
 * Remplace les gestes de l'utilisateur sur la liste des dossiers. La valeur
 * est validée AVANT d'être écrite : la base ne reçoit jamais ce que
 * `readWorkspaceSandbox` refuserait de relire.
 */
export async function setWorkspaceSandboxFolders(
  db: AnyDrizzleDb,
  entityId: string,
  folders: SandboxFolders,
): Promise<void> {
  const valid = parseSandboxFolders(folders);
  await db
    .update(entities)
    .set({ sandboxFolders: valid, updatedAt: new Date() })
    .where(eq(entities.id, entityId));
}
