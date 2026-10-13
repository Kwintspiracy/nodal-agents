// cancel-job-tree.test.ts — le seul chemin d'annulation (#567), partagé par le
// bouton Stop du web (`cancelJobAction`) et l'outil `stop_conversation_run`.
//
// Deux propriétés que les deux appelants tiennent d'ici : l'annulation ne sort
// jamais de l'espace de travail demandé, et « terminé » se juge sur ce qui vit
// dans l'arbre, pas sur le statut de la tête seule.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agentJobs, approvalRequests, entities } from '../schema/index.ts';
import { cancelJobTree } from '../repos/conversation-runs.ts';
import type { AnyDrizzleDb } from '../client.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

async function job(values: { status: string; parentJobId?: string }): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 't',
      ...values,
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function statuses(ids: string[]) {
  const rows = await db
    .select({ id: agentJobs.id, status: agentJobs.status })
    .from(agentJobs)
    .where(inArray(agentJobs.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

describe('cancelJobTree @cap:suivre-execution/moteur', () => {
  it('a head the reaper failed, whose delegate still runs: the delegate is cancelled, the head keeps its status', async () => {
    const head = await job({ status: 'failed' });
    const child = await job({ status: 'processing', parentJobId: head });
    const grandchild = await job({ status: 'completed', parentJobId: child });

    const out = await cancelJobTree(db as unknown as AnyDrizzleDb, {
      entityId: seed.entityId,
      jobId: head,
    });

    expect(out).toEqual({ jobIds: [child], taskIds: [], requestIds: [], discardedMessages: [] });
    expect(await statuses([head, child, grandchild])).toEqual({
      [head]: 'failed',
      [child]: 'cancelled',
      [grandchild]: 'completed',
    });
  });

  it('never reaches another workspace, even given one of its job ids', async () => {
    const [otherEntity] = await db
      .insert(entities)
      .values({ userId: seed.userId, name: 'Other', slug: `other-${Date.now()}` })
      .returning({ id: entities.id });
    const head = await job({ status: 'awaiting_approval' });
    const [req] = await db
      .insert(approvalRequests)
      .values({ entityId: seed.entityId, jobId: head, toolName: 'run_command', toolInput: {} })
      .returning({ id: approvalRequests.id });

    const out = await cancelJobTree(db as unknown as AnyDrizzleDb, {
      entityId: otherEntity!.id,
      jobId: head,
    });

    expect(out).toEqual({ jobIds: [], taskIds: [], requestIds: [], discardedMessages: [] });
    expect(await statuses([head])).toEqual({ [head]: 'awaiting_approval' });
    const [still] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, req!.id));
    expect(still?.status).toBe('pending');
  });
});
