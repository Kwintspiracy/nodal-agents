// run-cost.test.ts — ce qu'un run a coûté : sa tête et tout ce qui en descend (revue de #836, P1 et passe 2).
//
// Le budget de run (Guard 1e du runner) compare au plafond la dépense de
// l'ARBRE. Ces cas posent un arbre réel (`parent_job_id`, `relaunched_from_job_id`)
// et lisent, depuis n'importe lequel de ses jobs, la même tête et les mêmes
// jobs ; un autre run de l'espace n'y entre jamais, ni un job d'un AUTRE
// espace, quel que soit le lien qui le désigne (`parent_job_id` n'a pas de clé
// étrangère). Le run est celui que l'arrêt (`cancelJobTree`) arrête : même
// définition, `run-tree.ts`.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';
import { readRunCost, runSpentUsd } from '../repos/run-cost.ts';
import { cancelJobTree } from '../repos/conversation-runs.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherEntityId: string;
let otherAgentId: string;

async function job(
  fields: {
    parentJobId?: string | null;
    relaunchedFromJobId?: string | null;
    totalCostUsd?: number | null;
    status?: string;
  } = {},
  space: 'here' | 'other' = 'here',
): Promise<string> {
  const [row] = await db
    .insert(schema.agentJobs)
    .values({
      entityId: space === 'here' ? seed.entityId : otherEntityId,
      agentId: space === 'here' ? seed.agentId : otherAgentId,
      channel: 'api',
      task: 't',
      status: fields.status ?? 'processing',
      parentJobId: fields.parentJobId ?? null,
      relaunchedFromJobId: fields.relaunchedFromJobId ?? null,
      totalCostUsd: fields.totalCostUsd === undefined ? 0 : fields.totalCostUsd,
    })
    .returning({ id: schema.agentJobs.id });
  return row!.id;
}

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [other] = await db
    .insert(schema.entities)
    .values({ userId: seed.userId, name: 'Other', slug: 'other-space' })
    .returning({ id: schema.entities.id });
  otherEntityId = other!.id;
  const [agent] = await db
    .insert(schema.agents)
    .values({ entityId: otherEntityId, slug: 'other-agent', name: 'Other', personality: 'x' })
    .returning({ id: schema.agents.id });
  otherAgentId = agent!.id;
});

describe('readRunCost @cap:voir-le-cout/moteur', () => {
  it('from any job of the tree: the same head, every descendant, and no job of another run', async () => {
    const head = await job({ totalCostUsd: 0.5 });
    const a = await job({ parentJobId: head, totalCostUsd: 0.25 });
    const deep = await job({ parentJobId: a, totalCostUsd: 0.125 });
    const sibling = await job({ parentJobId: head, totalCostUsd: null });
    const otherRun = await job({ totalCostUsd: 9 });
    await job({ parentJobId: otherRun, totalCostUsd: 9 });

    for (const from of [head, a, deep, sibling]) {
      const run = await readRunCost(db, from);
      expect(run.headJobId).toBe(head);
      expect(run.jobs.map((j) => j.id).sort()).toEqual([head, a, deep, sibling].sort());
    }
    const run = await readRunCost(db, deep);
    // A cost the row does not know counts zero, as for a lone job's guard.
    expect(run.jobs.find((j) => j.id === sibling)?.costUsd).toBe(0);
    // The live job's own spend replaces its written one: fresher, in memory.
    expect(runSpentUsd(run, deep, 1)).toBeCloseTo(0.5 + 0.25 + 1, 10);
  });

  it('a parent link into ANOTHER workspace is not climbed: the job is its own head, the foreign spend never counts', async () => {
    const foreignHead = await job({ totalCostUsd: 50 }, 'other');
    const mine = await job({ parentJobId: foreignHead, totalCostUsd: 0.4 });
    const mineChild = await job({ parentJobId: mine, totalCostUsd: 0.1 });
    const run = await readRunCost(db, mineChild);
    expect(run.headJobId).toBe(mine);
    expect(run.jobs.map((j) => j.id).sort()).toEqual([mine, mineChild].sort());
    expect(runSpentUsd(run, mineChild, 0.1)).toBeCloseTo(0.5, 10);
  });

  it('a child of ANOTHER workspace pointing at this run is not counted in it', async () => {
    const head = await job({ totalCostUsd: 0.2 });
    const foreignChild = await job({ parentJobId: head, totalCostUsd: 40 }, 'other');
    // A job of THIS workspace hanging under the foreign one: the descent never
    // crosses the foreign hop, exactly as its own climb stops at it.
    const underForeign = await job({ parentJobId: foreignChild, totalCostUsd: 3 });
    const run = await readRunCost(db, head);
    expect(run.jobs.map((j) => j.id)).toEqual([head]);
    expect(runSpentUsd(run, head, 0.2)).toBeCloseTo(0.2, 10);
    expect((await readRunCost(db, underForeign)).headJobId).toBe(underForeign);
  });

  it('the head its queue relaunched (#531) is part of the run, as for the Stop: the same tree as cancelJobTree', async () => {
    const head = await job({ totalCostUsd: 0.3, status: 'completed' });
    const relaunched = await job({ relaunchedFromJobId: head, totalCostUsd: 0.6 });
    const child = await job({ parentJobId: relaunched, totalCostUsd: 0.1 });
    await job({ relaunchedFromJobId: head, totalCostUsd: 7 }, 'other');
    const run = await readRunCost(db, head);
    expect(run.jobs.map((j) => j.id).sort()).toEqual([head, relaunched, child].sort());
    // The Stop reaches exactly the same live jobs of the tree.
    const stopped = await cancelJobTree(db, { entityId: seed.entityId, jobId: head });
    expect(stopped.jobIds.sort()).toEqual([relaunched, child].sort());
  });
});
