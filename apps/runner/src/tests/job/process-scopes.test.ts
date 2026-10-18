// process-scopes.test.ts — QUAND le périmètre d'un job se ferme (#628) : à la
// fin du job, quelle qu'elle soit, et jamais avant. Sur la vraie table
// `agent_jobs` ; la mort réelle des processus est prouvée de bout en bout par
// run-command-flow.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, eq } from '@nodal-agents/db';
import {
  closeAllJobProcessScopes,
  jobProcessScope,
  openJobProcessScopeIds,
} from '@nodal-agents/sandbox';
import {
  JOB_PROCESSES_RELEASED,
  releaseIfEnded,
  startJobProcessSweep,
} from '../../job/process-scopes.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const asDb = () => db as unknown as Parameters<typeof releaseIfEnded>[0];

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

afterAll(async () => {
  await closeAllJobProcessScopes();
});

async function job(status: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 't', status })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

describe('releaseIfEnded @cap:executer-une-commande/moteur', () => {
  it('a job still alive keeps its processes: processing, pending (self-chain), awaiting approval or delegation', async () => {
    const ids = await Promise.all(
      ['processing', 'pending', 'awaiting_approval', 'awaiting_delegation'].map(job),
    );
    for (const id of ids) jobProcessScope(id);
    const released = await releaseIfEnded(asDb(), ids, () => {});
    expect(released).toEqual([]);
    for (const id of ids) expect(openJobProcessScopeIds()).toContain(id);
  });

  it('a finished job releases them, whatever the end: completed, failed, cancelled', async () => {
    const ids = await Promise.all(['completed', 'failed', 'cancelled'].map(job));
    for (const id of ids) jobProcessScope(id);
    const logged: { code: string; data: Record<string, unknown> }[] = [];
    const released = await releaseIfEnded(asDb(), ids, (code, data) => logged.push({ code, data }));
    expect(released.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(openJobProcessScopeIds()).not.toContain(id);
    expect(logged.map((l) => l.code)).toEqual([
      JOB_PROCESSES_RELEASED,
      JOB_PROCESSES_RELEASED,
      JOB_PROCESSES_RELEASED,
    ]);
  });

  it('a job whose row is gone releases them too', async () => {
    const id = await job('processing');
    jobProcessScope(id);
    await db.delete(agentJobs).where(eq(agentJobs.id, id));
    expect(await releaseIfEnded(asDb(), [id], () => {})).toEqual([id]);
    expect(openJobProcessScopeIds()).not.toContain(id);
  });

  it('closing one job leaves the other jobs’ scopes open', async () => {
    const done = await job('completed');
    const live = await job('processing');
    jobProcessScope(done);
    jobProcessScope(live);
    await releaseIfEnded(asDb(), [done, live], () => {});
    expect(openJobProcessScopeIds()).not.toContain(done);
    expect(openJobProcessScopeIds()).toContain(live);
  });

  it('the periodic sweep releases a job stopped while suspended, which no run sees end', async () => {
    const id = await job('awaiting_approval');
    jobProcessScope(id);
    const sweep = startJobProcessSweep(asDb(), 50);
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(openJobProcessScopeIds()).toContain(id);
      // Le Stop d'un job suspendu : sa ligne passe à `cancelled`, aucun run ne tourne.
      await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, id));
      for (let i = 0; i < 40 && openJobProcessScopeIds().includes(id); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(openJobProcessScopeIds()).not.toContain(id);
    } finally {
      sweep.stop();
    }
  });
});
