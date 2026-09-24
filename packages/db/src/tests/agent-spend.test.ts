// agent-spend.test.ts — le compteur du budget d'un agent (#447).
//
// Ce que ça prouve, contre des lignes réelles de `llm_calls` et `cli_runs` :
//   - les deux sources comptent ENSEMBLE, quel que soit le fournisseur ;
//   - « aujourd'hui » et « ce mois-ci » commencent à minuit et au 1er dans le
//     fuseau de l'ESPACE, pas du serveur ;
//   - un appel sans prix (NULL) vaut 0, et un autre agent ne compte pas ;
//   - la fenêtre atteinte : le jour passe avant le mois, 0 = aucun plafond.

import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal, type TestDb } from './helpers.ts';
import { agents, entities } from '../schema/index.ts';
import { readAgentSpend, readAgentBudgetState, budgetReached } from '../repos/agent-spend.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherAgentId: string;

async function call(
  agentId: string,
  costUsd: number | null,
  at = sql`now()`,
  provider = 'openrouter',
) {
  await db.execute(sql`
    INSERT INTO llm_calls (entity_id, agent_id, source, model_effective, provider, cost_usd, created_at)
    VALUES (${seed.entityId}, ${agentId}, 'job', 'm', ${provider}, ${costUsd}, ${at})`);
}

async function cliRun(agentId: string, costUsd: number | null, at = sql`now()`) {
  await db.execute(sql`
    INSERT INTO cli_runs (entity_id, agent_id, provider, mode, cost_usd, created_at)
    VALUES (${seed.entityId}, ${agentId}, 'claude', 'read', ${costUsd}, ${at})`);
}

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [other] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Other',
      slug: `other-${Date.now()}`,
      personality: 'p',
    })
    .returning({ id: agents.id });
  otherAgentId = other!.id;
});

describe('readAgentSpend @cap:voir-le-cout/moteur', () => {
  it('adds API calls of every provider and coding-CLI runs, today and this month', async () => {
    await call(seed.agentId, 0.4);
    await call(seed.agentId, 0.1, sql`now()`, 'anthropic');
    await cliRun(seed.agentId, 1.5);
    await call(seed.agentId, null); // no known price: counts 0, never guessed
    await cliRun(seed.agentId, null); // codex reports nothing
    await call(otherAgentId, 9); // another agent does not count

    const spend = await readAgentSpend(db, seed.agentId, 'UTC');
    expect(spend.todayUsd).toBeCloseTo(2.0, 5);
    expect(spend.monthUsd).toBeCloseTo(2.0, 5);
  });

  it('the windows start at midnight and on the 1st in the WORKSPACE timezone', async () => {
    // A fresh agent, so earlier rows do not blur the sums.
    const [a] = await db
      .insert(agents)
      .values({ entityId: seed.entityId, name: 'Tz', slug: `tz-${Date.now()}`, personality: 'p' })
      .returning({ id: agents.id });
    const id = a!.id;
    const at = (iso: string) => sql`${iso}::timestamptz`;
    const now = new Date('2026-09-24T12:00:00Z');

    // 02:00 UTC on the 24th: still the 23rd in Los Angeles (19:00), already
    // the 24th in Singapore (10:00) and in UTC.
    await call(id, 1, at('2026-09-24T02:00:00Z'));
    // 20:00 UTC on 31 August: already 1 September in Singapore (04:00),
    // still August in UTC.
    await call(id, 10, at('2026-08-31T20:00:00Z'));
    // Last month everywhere.
    await call(id, 100, at('2026-08-15T12:00:00Z'));

    expect(await readAgentSpend(db, id, 'UTC', now)).toEqual({ todayUsd: 1, monthUsd: 1 });
    expect(await readAgentSpend(db, id, 'Asia/Singapore', now)).toEqual({
      todayUsd: 1,
      monthUsd: 11,
    });
    expect(await readAgentSpend(db, id, 'America/Los_Angeles', now)).toEqual({
      todayUsd: 0,
      monthUsd: 1,
    });
  });
});

describe('readAgentBudgetState @cap:voir-le-cout/moteur', () => {
  it('reads the ceilings, the workspace timezone, and which window is reached', async () => {
    await db
      .update(entities)
      .set({ timezone: 'Europe/Paris' })
      .where(eq(entities.id, seed.entityId));
    await db
      .update(agents)
      .set({ budgetDailyUsd: 1, budgetMonthlyUsd: 1000, budgetAlertPct: 70 })
      .where(eq(agents.id, seed.agentId));

    const state = await readAgentBudgetState(db, seed.agentId, 'UTC');
    expect(state).not.toBeNull();
    expect(state!.timezone).toBe('Europe/Paris');
    expect(state!.dailyUsd).toBe(1);
    expect(state!.monthlyUsd).toBe(1000);
    expect(state!.alertPct).toBe(70);
    expect(state!.todayUsd).toBeGreaterThanOrEqual(2);
    expect(state!.reached).toBe('day');
  });

  it('budgetReached: 0 means no ceiling, the day before the month', () => {
    expect(budgetReached({ dailyUsd: 0, monthlyUsd: 0 }, { todayUsd: 999, monthUsd: 999 })).toBe(
      null,
    );
    expect(budgetReached({ dailyUsd: 5, monthlyUsd: 10 }, { todayUsd: 5, monthUsd: 12 })).toBe(
      'day',
    );
    expect(budgetReached({ dailyUsd: 5, monthlyUsd: 10 }, { todayUsd: 4.99, monthUsd: 10 })).toBe(
      'month',
    );
    expect(budgetReached({ dailyUsd: 5, monthlyUsd: 10 }, { todayUsd: 4.99, monthUsd: 9.99 })).toBe(
      null,
    );
  });
});
