// agent-budget-actions.test.ts — les actions du budget de l'agent (#447),
// relues EN BASE.
//
//   - la dépense rendue est la somme des appels d'API ET des runs de CLI de
//     l'agent, dans la fenêtre, et rien d'un autre agent ;
//   - l'écriture pose les trois colonnes ; hors bornes, rien ne change ;
//   - hors local-trust, un tiers ne change rien ;
//   - un agent d'un autre espace n'est ni lu ni écrit.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, sql, agents, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherUserId: string;
let foreignAgentId: string;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const authState = vi.hoisted(() => ({ mode: 'local-trust' as 'local-trust' | 'local-auth' }));
vi.mock('../env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.ts')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) => (prop === 'AUTH_MODE' ? authState.mode : Reflect.get(target, prop)),
    }),
  };
});
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  const [other] = await testDb
    .insert(users)
    .values({ email: `tiers-${Date.now()}@example.com` })
    .returning();
  otherUserId = other!.id;
  const [foreignEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUserId, name: 'Voisin', slug: `voisin-${Date.now()}` })
    .returning();
  const [foreign] = await testDb
    .insert(agents)
    .values({ entityId: foreignEntity!.id, name: 'F', slug: `f-${Date.now()}`, personality: 'p' })
    .returning({ id: agents.id });
  foreignAgentId = foreign!.id;

  // What the agent spent: two API calls (two providers) and a CLI run, plus
  // one call by another agent that must not count.
  await testDb.execute(sql`
    INSERT INTO llm_calls (entity_id, agent_id, source, model_effective, provider, cost_usd) VALUES
      (${seed.entityId}, ${seed.agentId}, 'job', 'm', 'openrouter', 0.75),
      (${seed.entityId}, ${seed.agentId}, 'chat', 'm', 'anthropic', 0.25),
      (${seed.entityId}, ${foreignAgentId}, 'job', 'm', 'openrouter', 99)`);
  await testDb.execute(sql`
    INSERT INTO cli_runs (entity_id, agent_id, provider, mode, cost_usd)
    VALUES (${seed.entityId}, ${seed.agentId}, 'claude', 'read', 2)`);
});

beforeEach(() => {
  authState.mode = 'local-trust';
});

async function row() {
  const [r] = await testDb
    .select({
      d: agents.budgetDailyUsd,
      m: agents.budgetMonthlyUsd,
      p: agents.budgetAlertPct,
    })
    .from(agents)
    .where(eq(agents.id, seed.agentId));
  return r;
}

describe('agent budget actions @cap:voir-le-cout/moteur', () => {
  it('reads what the agent spent, API calls and CLI runs together', async () => {
    const { getAgentBudgetAction } = await import('../actions.ts');
    const r = await getAgentBudgetAction(seed.agentId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.todayUsd).toBeCloseTo(3, 5);
    expect(r.data.monthUsd).toBeCloseTo(3, 5);
    expect(r.data.dailyUsd).toBe(0);
    expect(r.data.reached).toBeNull();
  });

  it('writes the three settings, and a reached ceiling reads back as reached', async () => {
    const { setAgentBudgetAction, getAgentBudgetAction } = await import('../actions.ts');
    const w = await setAgentBudgetAction({
      agentId: seed.agentId,
      dailyUsd: 2.5,
      monthlyUsd: 50,
      alertPct: 70,
    });
    expect(w.ok).toBe(true);
    expect(await row()).toEqual({ d: 2.5, m: 50, p: 70 });
    const r = await getAgentBudgetAction(seed.agentId);
    expect(r.ok && r.data.reached).toBe('day');
  });

  it('refuses out-of-bounds values and changes nothing', async () => {
    const { setAgentBudgetAction } = await import('../actions.ts');
    for (const bad of [
      { dailyUsd: -1, monthlyUsd: 0, alertPct: 80 },
      { dailyUsd: 1001, monthlyUsd: 0, alertPct: 80 },
      { dailyUsd: 0, monthlyUsd: 10_001, alertPct: 80 },
      { dailyUsd: 0, monthlyUsd: 0, alertPct: 0 },
      { dailyUsd: 0, monthlyUsd: 0, alertPct: 80.5 },
    ]) {
      const r = await setAgentBudgetAction({ agentId: seed.agentId, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(await row()).toEqual({ d: 2.5, m: 50, p: 70 });
  });

  it('outside local-trust a non-owner changes nothing', async () => {
    const { setAgentBudgetAction } = await import('../actions.ts');
    authState.mode = 'local-auth';
    await testDb
      .update(entities)
      .set({ userId: otherUserId })
      .where(eq(entities.id, seed.entityId));
    try {
      const r = await setAgentBudgetAction({
        agentId: seed.agentId,
        dailyUsd: 0,
        monthlyUsd: 0,
        alertPct: 80,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('forbidden');
    } finally {
      await testDb
        .update(entities)
        .set({ userId: seed.userId })
        .where(eq(entities.id, seed.entityId));
    }
    expect(await row()).toEqual({ d: 2.5, m: 50, p: 70 });
  });

  it('an agent of another workspace is neither read nor written', async () => {
    const { setAgentBudgetAction, getAgentBudgetAction } = await import('../actions.ts');
    const r = await getAgentBudgetAction(foreignAgentId);
    expect(r.ok).toBe(false);
    const w = await setAgentBudgetAction({
      agentId: foreignAgentId,
      dailyUsd: 1,
      monthlyUsd: 1,
      alertPct: 50,
    });
    expect(w.ok).toBe(false);
  });
});
