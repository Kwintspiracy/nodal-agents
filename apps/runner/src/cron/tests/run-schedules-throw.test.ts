// run-schedules-throw.test.ts — regression for fix #3.
//
// runScheduleTick previously SWALLOWED an executeJob throw (the Promise.allSettled
// rejected branch did `continue`), leaving the schedule's last_status = null and
// losing which schedule raised. A re-thrown fatal (MessageStructureError /
// QuotaExhaustedError bypass the in-loop failJob) is the real-world trigger.
//
// We mock executeJob to throw so the catch is exercised deterministically; the
// common (non-throwing) path is covered by run-schedules.test.ts.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentSchedules, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';

// executeJob THROWS — exercises runScheduleTick's per-fire catch (#3).
vi.mock('../../job/execute.ts', () => ({
  executeJob: vi.fn(async () => {
    throw new Error('simulated re-thrown fatal');
  }),
}));

import { runScheduleTick } from '../run-schedules.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const r = await spinUpTestDb();
  db = r.db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
});

function makeDeps(): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'], // unused — executeJob is mocked
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

describe('runScheduleTick — executeJob throw handling (#3)', () => {
  it('marks the schedule last_status=failed (not null) when executeJob throws', async () => {
    const [sched] = await db
      .insert(agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        type: 'cron',
        name: 'throw test',
        cronExpr: '0 9 * * *',
        task: 'x',
        active: true,
        nextRun: null,
        notifyOnSuccess: false,
      })
      .returning();

    const fired = await runScheduleTick(db as RunnerDeps['db'], makeDeps(), 5);
    expect(fired).toBeGreaterThanOrEqual(1);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched!.id));
    // The throw must NOT leave last_status null — it must be recorded as 'failed'.
    expect(after[0]?.lastStatus).toBe('failed');
  });
});
