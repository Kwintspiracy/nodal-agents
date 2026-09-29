// child-birth-after-cancel.test.ts — une tâche réclamée avant un arrêt ne fait
// naître aucun enfant après lui (#567, revue Codex de #572, passe 3).
//
// Le scénario : le cron réclame une tâche du tableau, lit le job qui l'a créée,
// et au moment où il va insérer l'enfant, l'arrêt tombe (le bouton Stop, ou
// `stop_conversation_run`). Avant, le worker avait déjà lu le statut de la tête
// et insérait quand même : un enfant que l'arrêt n'avait pas vu naissait, et
// tournait. L'insertion passe maintenant par `insertChildJob`, qui relit le
// parent et la tâche SOUS verrou, au moment même de l'insertion.
//
// PGlite n'a qu'une connexion : l'arrêt est joué juste avant l'insertion, par
// une base-témoin qui intercepte le premier geste d'insertion. Les deux
// transactions qui s'attendent pour de vrai sont prouvées sur Postgres dans
// packages/db/src/tests/child-birth-vs-cancel.pg.test.ts.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks, cancelJobTree, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';

const executeJobMock = vi.fn(async () => ({ status: 'completed' }));
vi.mock('../../job/execute.ts', () => ({
  executeJob: (...args: unknown[]) => executeJobMock(...(args as [])),
}));

const { executeReadyTasks } = await import('../../cron/execute-ready.ts');

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

/**
 * La base du cron, sauf que le premier geste qui ferait naître un job (une
 * transaction, ou une insertion dans `agent_jobs`) est précédé de l'arrêt du
 * run : l'arrêt tombe APRÈS la réclamation et la lecture du créateur, AVANT
 * l'insertion — la fenêtre de la revue.
 */
function cancelRightBeforeBirth(rootJobId: string): AnyDrizzleDb {
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await cancelJobTree(db as unknown as AnyDrizzleDb, {
      entityId: seed.entityId,
      jobId: rootJobId,
    });
  };
  return new Proxy(db as unknown as AnyDrizzleDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (...args: unknown[]) => {
          await fire();
          return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table !== agentJobs) return target.insert(table as typeof agentJobs);
          const builder = target.insert(agentJobs);
          return {
            values: (v: unknown) => ({
              returning: async (sel?: unknown) => {
                await fire();
                return (
                  builder.values(v as typeof agentJobs.$inferInsert).returning as (
                    s?: unknown,
                  ) => Promise<unknown>
                )(sel);
              },
            }),
          };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

describe('a task claimed before a stop spawns no child after it @cap:parler-par-canal-externe/moteur', () => {
  it('the cancel lands between the claim and the insert: no child row, nothing executed, the task stays cancelled', async () => {
    executeJobMock.mockClear();
    const [root] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'Fais trois portraits',
        status: 'awaiting_delegation',
      })
      .returning({ id: agentJobs.id });
    const [task] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        title: 'Portrait 1',
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        rootJobId: root!.id,
        status: 'todo',
      })
      .returning({ id: agentTasks.id });

    const spawned = await executeReadyTasks(cancelRightBeforeBirth(root!.id), {
      db,
    } as unknown as RunnerDeps);

    expect(spawned).toBe(0);
    expect(executeJobMock).not.toHaveBeenCalled();
    const children = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, root!.id));
    expect(children).toEqual([]);
    const [row] = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task!.id));
    expect(row?.status).toBe('cancelled');
    const [rootRow] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, root!.id));
    expect(rootRow?.status).toBe('cancelled');
  });
});
