// activity-model-attribution.test.ts — the home page's activity chart must
// attribute each week to the model that ACTUALLY answered that week.
//
// The bug, reported live on 2026-08-21: "the week of 22 June shows GLM 5.3
// called 125 times, and GLM 5.3 came out yesterday." The jobs were real; the
// model attributed to them was not. `loadActivity` joined `agents.model` — the
// model configured TODAY — onto jobs of any date, so switching an agent's model
// rewrote twelve weeks of history.
//
// The fix reads `llm_calls.model_effective`, recorded per call at the time of
// the call. These tests pin the property that makes the difference: changing an
// agent's model must leave past buckets untouched.
//
// Asserts on rows produced by the real action against a real database
// (invariant #5) — a call-count test would have passed all along.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, llmCalls, eq } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

/** A day inside the rolling 7-day window, as a Date. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe('activity chart — model attribution', () => {
  it('attributes each day to the model that answered THAT day, not the one set today', async () => {
    // Two calls by the same agent, two days apart, two different models —
    // exactly what happens when someone switches an agent's model.
    await testDb.insert(llmCalls).values([
      {
        entityId: seed.entityId,
        source: 'job',
        provider: 'openrouter',
        modelEffective: 'old-model-v1',
        createdAt: daysAgo(3),
      },
      {
        entityId: seed.entityId,
        source: 'job',
        provider: 'openrouter',
        modelEffective: 'new-model-v2',
        createdAt: daysAgo(1),
      },
    ]);

    // Then the agent is switched to something else entirely. Under the old
    // code this value alone decided what every past bucket displayed.
    await testDb
      .update(agents)
      .set({ model: 'brand-new-model-v3' })
      .where(eq(agents.id, seed.agentId));

    const { getDailyActivityAction } = await import('../actions.ts');
    const res = await getDailyActivityAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const dayOf = (d: Date) => res.data.rows.find((r) => r.week === iso(d));

    // Each day keeps the model that actually answered it…
    expect(Object.keys(dayOf(daysAgo(3))?.models ?? {}).join()).toMatch(/old-model-v1/);
    expect(Object.keys(dayOf(daysAgo(1))?.models ?? {}).join()).toMatch(/new-model-v2/);

    // …and the model configured TODAY never appears in a past bucket. This is
    // the assertion the old implementation failed.
    for (const row of res.data.rows) {
      expect(
        Object.keys(row.models).join(),
        `${row.week} was attributed a model the agent only carries now`,
      ).not.toMatch(/brand-new-model-v3/);
    }
  });

  it('leaves a day with no inference trace without any model line', async () => {
    // Days before llm_calls existed (migration 0075, 19/08/2026) carry no model
    // data. Showing a plausible model there is exactly the bug; showing nothing
    // says "not measured", which is true.
    const { getDailyActivityAction } = await import('../actions.ts');
    const res = await getDailyActivityAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const iso = new Date();
    iso.setUTCDate(iso.getUTCDate() - 5);
    const quietDay = res.data.rows.find((r) => r.week === iso.toISOString().slice(0, 10));
    expect(quietDay, 'the 7-day window should include this day').toBeDefined();
    expect(Object.keys(quietDay!.models)).toHaveLength(0);
  });

  it('still counts jobs in the status bars, even with no inference trace', async () => {
    // The bars come from agent_jobs and must be unaffected by the model split:
    // a job from before the trace existed still counts as work done.
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'activity chart fixture',
      status: 'completed',
      createdAt: daysAgo(2),
    });

    const { getDailyActivityAction } = await import('../actions.ts');
    const res = await getDailyActivityAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const d = daysAgo(2).toISOString().slice(0, 10);
    const row = res.data.rows.find((r) => r.week === d);
    expect(row?.completed ?? 0).toBeGreaterThan(0);
  });
});
