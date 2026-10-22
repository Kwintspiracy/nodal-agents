// run-cost.test.ts — ce qu'un run a coûté : sa tête et tout ce qu'elle a délégué (revue de #836, P1).
//
// Le budget de run (Guard 1e du runner) compare au plafond la dépense de
// l'ARBRE. Ces cas posent un arbre réel (`parent_job_id`) et lisent, depuis
// n'importe lequel de ses jobs, la même tête et les mêmes jobs ; un autre run
// de l'espace n'y entre jamais.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';
import { readRunCost, runSpentUsd } from '../repos/run-cost.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

async function job(parentJobId: string | null, totalCostUsd: number | null): Promise<string> {
  const [row] = await db
    .insert(schema.agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 't',
      parentJobId,
      totalCostUsd,
    })
    .returning({ id: schema.agentJobs.id });
  return row!.id;
}

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

describe('readRunCost @cap:voir-le-cout/moteur', () => {
  it('from any job of the tree: the same head, every descendant, and no job of another run', async () => {
    const head = await job(null, 0.5);
    const a = await job(head, 0.25);
    const deep = await job(a, 0.125);
    const sibling = await job(head, null);
    const otherRun = await job(null, 9);
    await job(otherRun, 9);

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
});
