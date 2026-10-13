// usage-unknown-aggregates.test.ts — un total ne change jamais un usage
// inconnu en 0 (revue Codex de #571, passe 3).
//
// Le runner écrit NULL dans `agent_jobs.input_tokens`, `output_tokens` et
// `total_cost_usd` quand un appel du job n'a pas rapporté son compte. Un
// `coalesce(sum(x), 0)` sautait ces lignes : « tout inconnu » devenait 0, et des
// lignes mêlées un total présenté comme complet. Prouvé sur une vraie base
// (PGlite), par les vraies actions et le vrai rendu du titre.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentSchedules, eq } from '@nodal-agents/db';

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

import { getEntityStatsAction, getAutomationAction } from '@/lib/actions.ts';
import { runsHeadline } from '@/app/(dashboard)/automations/[id]/automation-view.ts';
import { aggregateSpaceCost } from '@/lib/space-cost.ts';

let scheduleId: string;

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  // Tout job du seed part de zéro : le test lit des totaux exacts.
  await testDb.delete(agentJobs).where(eq(agentJobs.entityId, seed.entityId));
  const [schedule] = await testDb
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: 'Digest',
      cronExpr: '0 9 * * 1',
      task: 'digest',
      active: true,
    })
    .returning();
  scheduleId = schedule!.id;
  const base = {
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'cron',
    task: 'digest',
    status: 'completed',
    scheduleId,
    createdAt: new Date(Date.now() - 60_000),
  };
  await testDb.insert(agentJobs).values([
    // Un run dont tout est connu.
    { ...base, inputTokens: 1_000, outputTokens: 200, totalCostUsd: 0.03 },
    // Un run dont l'usage n'a pas été rapporté : NULL, pas 0.
    { ...base, inputTokens: null, outputTokens: null, totalCostUsd: null },
  ]);
});

describe('aggregates never turn an unknown usage into 0 @cap:suivre-execution/ecran', () => {
  it('entity stats: the known part, and how many runs are not reported', async () => {
    const res = await getEntityStatsAction();
    if (!res.ok) throw new Error(res.message);
    const s = res.data;

    expect(s.totalInputTokens).toEqual({ known: 1_000, unreported: 1 });
    expect(s.totalOutputTokens).toEqual({ known: 200, unreported: 1 });
    // Per job: only over the jobs whose two counts are known.
    expect(s.tokensPerJob).toBe(1_200);
    expect(s.perAgent).toHaveLength(1);
    expect(s.perAgent[0]).toMatchObject({
      jobCount: 2,
      inputTokens: { known: 1_000, unreported: 1 },
      outputTokens: { known: 200, unreported: 1 },
    });
  });

  it('automation window: the unknown cost is counted apart and the headline says so', async () => {
    const res = await getAutomationAction(scheduleId);
    if (!res.ok) throw new Error(res.message);

    expect(res.data.window).toMatchObject({ runs: 2, unreportedCostRuns: 1 });
    expect(res.data.window.costUsd).toBeCloseTo(0.03, 6);
    expect(runsHeadline(res.data)).toBe('Runs · 2 · ≥ $0.03 over 30 days, 1 unknown');
  });

  it('space cost: a call without its token counts makes the token totals partial', () => {
    const call = {
      agentId: seed.agentId,
      agentName: 'A',
      modelEffective: 'm',
      jobId: null,
      provider: 'openrouter',
      createdAt: null,
      cachedTokens: null,
      cacheCreationTokens: null,
      costUsd: 0.01,
      durationMs: 10,
    };
    const view = aggregateSpaceCost({
      calls: [
        { ...call, inputTokens: 900, outputTokens: 100 },
        { ...call, inputTokens: null, outputTokens: null },
      ],
      approvals: [],
      proofMs: 0,
      startedAt: null,
      endedAt: null,
    });

    expect(view.totals).toMatchObject({ inputTokens: 900, unreportedTokenCalls: 1 });
    expect(view.byAgent[0]?.unreportedTokenCalls).toBe(1);
  });
});
