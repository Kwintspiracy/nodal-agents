// workspace-db.ts — une VRAIE base et un espace, pour les tests d'outils qui
// lancent une commande (#876).
//
// `run_command` et `run_skill_script` relisent le réglage du bac à sable de
// l'espace à chaque commande (`readWorkspaceSandbox`, @nodal-agents/db). Un
// contexte d'outil sans base n'a donc plus de sens pour eux : la commande y
// serait refusée (`SANDBOX_SETTINGS_UNREADABLE`), et c'est voulu. Ces tests
// reçoivent ici une base de test et l'espace d'un `seedMinimal`, dont le
// réglage est celui par défaut (allumé, aucun geste sur les dossiers).

import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { ToolContext } from '../types';

export interface WorkspaceDb {
  readonly db: ToolContext['db'];
  readonly entityId: string;
}

/** Une base de test et l'identifiant de son espace. */
export async function workspaceDb(): Promise<WorkspaceDb> {
  const { db } = await spinUpTestDb();
  const seed = await seedMinimal(db);
  return { db: db as unknown as ToolContext['db'], entityId: seed.entityId };
}
