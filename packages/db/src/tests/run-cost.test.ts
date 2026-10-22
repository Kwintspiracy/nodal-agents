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
import { eq } from 'drizzle-orm';
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
    // The same for a relaunch link: a continuation "relaunched" from another
    // workspace's job is its own head.
    const foreignFinished = await job({ totalCostUsd: 30, status: 'completed' }, 'other');
    const continuation = await job({ relaunchedFromJobId: foreignFinished, totalCostUsd: 0.2 });
    const cont = await readRunCost(db, continuation);
    expect(cont.headJobId).toBe(continuation);
    expect(cont.jobs.map((j) => j.id)).toEqual([continuation]);
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

  // ─── The relaunch seam (review of #836, pass 3): ONE run, symmetric ───────
  //
  // The climb follows the same links as the descent. From ANY job of a chain
  // of relaunches and delegations: the same head, the same set, so one cap.

  it('a relaunched continuation and what it continues are one run, read from either side', async () => {
    const head = await job({ totalCostUsd: 1.5, status: 'completed' });
    const headDelegate = await job({ parentJobId: head, totalCostUsd: 0.2, status: 'completed' });
    const relaunched = await job({ relaunchedFromJobId: head, totalCostUsd: 0.3 });
    const relaunchedDelegate = await job({ parentJobId: relaunched, totalCostUsd: 0.1 });
    const all = [head, headDelegate, relaunched, relaunchedDelegate].sort();
    for (const from of all) {
      const run = await readRunCost(db, from);
      expect(run.headJobId).toBe(head);
      expect(run.jobs.map((j) => j.id).sort()).toEqual(all);
    }
    // The continuation's live spend counts against the run it continues.
    expect(runSpentUsd(await readRunCost(db, relaunched), relaunched, 0.5)).toBeCloseTo(
      1.5 + 0.2 + 0.5 + 0.1,
      10,
    );
  });

  it('the zombie window: a delegate still alive under a finished head and the relaunched head read the SAME run', async () => {
    // The relaunch trigger only refuses a live ANCESTOR (0141_job_inbox.sql):
    // a head that ended with a leftover inbox while its delegate still runs
    // gives birth to R while Z lives (conversation-inbox.test.ts models it).
    const head = await job({ totalCostUsd: 0.4, status: 'completed' });
    const zombie = await job({ parentJobId: head, totalCostUsd: 0.7, status: 'processing' });
    const relaunched = await job({ relaunchedFromJobId: head, totalCostUsd: 0.2 });
    const fromZombie = await readRunCost(db, zombie);
    const fromRelaunched = await readRunCost(db, relaunched);
    expect(fromZombie.headJobId).toBe(head);
    expect(fromRelaunched.headJobId).toBe(head);
    expect(fromZombie.jobs.map((j) => j.id).sort()).toEqual([head, zombie, relaunched].sort());
    expect(fromRelaunched.jobs).toEqual(fromZombie.jobs);
    // A Stop issued FROM the continuation still cancels only what descends from
    // it: the zombie delegate of the earlier head is not touched (the Stop does
    // not climb; its set is unchanged by this PR).
    const stopped = await cancelJobTree(db, { entityId: seed.entityId, jobId: relaunched });
    expect(stopped.jobIds).toEqual([relaunched]);
    const [z] = await db
      .select({ status: schema.agentJobs.status })
      .from(schema.agentJobs)
      .where(eq(schema.agentJobs.id, zombie));
    expect(z?.status).toBe('processing');
  });

  it('chained relaunches H → R1 → R2 are one run: the same head and ONE cap, never one per link', async () => {
    const head = await job({ totalCostUsd: 0.5, status: 'completed' });
    const r1 = await job({ relaunchedFromJobId: head, totalCostUsd: 0.5, status: 'completed' });
    const r2 = await job({ relaunchedFromJobId: r1, totalCostUsd: 0.25 });
    const run = await readRunCost(db, r2);
    expect(run.headJobId).toBe(head);
    expect(run.jobs.map((j) => j.id).sort()).toEqual([head, r1, r2].sort());
    expect(runSpentUsd(run, r2, 0.25)).toBeCloseTo(1.25, 10);
  });

  // ─── The climb and the descent have the SAME bounds (review of #836, pass 4) ─
  //
  // A leftover inbox relaunches a head at each end: a legitimate chain grows
  // one link per relaunch. The climb used to stop after 32 links, the descent
  // never: the last job of a longer chain then read a shorter run than the
  // first, and the cap came back once per 32 links.

  it('a 40-link relaunch chain reads ONE run, the same head, set and spend, from its first, middle and last job', async () => {
    const chain: string[] = [await job({ totalCostUsd: 0.5, status: 'completed' })];
    for (let i = 1; i < 40; i++) {
      chain.push(
        await job({
          relaunchedFromJobId: chain[i - 1]!,
          totalCostUsd: 0.5,
          status: i < 39 ? 'completed' : 'processing',
        }),
      );
    }
    const all = [...chain].sort();
    for (const from of [chain[0]!, chain[20]!, chain[39]!]) {
      const run = await readRunCost(db, from);
      expect(run.headJobId).toBe(chain[0]);
      expect(run.jobs.map((j) => j.id).sort()).toEqual(all);
      expect(runSpentUsd(run, from, 0.5)).toBeCloseTo(20, 10);
    }
  });

  it('a corrupt graph with a cycle (both links) terminates, and every job of the cycle reads the same set and spend', async () => {
    const a = await job({ totalCostUsd: 0.25 });
    const b = await job({ parentJobId: a, totalCostUsd: 0.5 });
    const c = await job({ relaunchedFromJobId: b, totalCostUsd: 1 });
    // A climbs to C, which climbs to B, which climbs to A: a loop no real
    // relaunch or delegation can write.
    await db
      .update(schema.agentJobs)
      .set({ relaunchedFromJobId: c })
      .where(eq(schema.agentJobs.id, a));
    // A climb that loops never yields to a timer (PGlite answers in microtasks):
    // the test bounds the reads itself, and fails, instead of hanging.
    let reads = 0;
    const bounded = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: Parameters<TestDb['select']>) => {
          if (++reads > 500) throw new Error('the climb did not terminate on a cycle');
          return target.select(...args);
        };
      },
    });
    const all = [a, b, c].sort();
    for (const from of [a, b, c]) {
      const run = await readRunCost(bounded, from);
      expect(run.jobs.map((j) => j.id).sort()).toEqual(all);
      expect(runSpentUsd(run, from, run.jobs.find((j) => j.id === from)!.costUsd)).toBeCloseTo(
        1.75,
        10,
      );
    }
  });
});
