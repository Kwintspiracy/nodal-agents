/**
 * agent-budget.spec.ts — le budget d'un agent, réglé dans son onglet Settings
 * et relu en base (#447).
 *
 * Ce que ce parcours prouve, au navigateur et dans la base :
 *  - la section Budget montre ce que l'agent a dépensé aujourd'hui, lu dans
 *    `llm_calls` ;
 *  - poser un plafond l'écrit dans `agents`, et l'écran prévient au seuil ;
 *  - un plafond déjà dépassé se dit comme une pause : les runs s'arrêtent
 *    jusqu'à minuit.
 *
 * L'agent et sa dépense sont créés pour le parcours et supprimés après.
 */

import { test, expect } from '@playwright/test';
import { eq, sql, agents } from '@nodal-agents/db';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

let agentId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Spender ${testSlugSuffix()}`,
        slug: `e2e-spender-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
    // What it already spent today, on an earlier run.
    await db.execute(sql`
      INSERT INTO llm_calls (entity_id, agent_id, source, model_effective, provider, cost_usd)
      VALUES (${acting.entityId}, ${agentId}, 'job', 'deepseek-chat', 'deepseek', 4.5)`);
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { db, close } = makeDbClient();
  try {
    await db.execute(sql`DELETE FROM llm_calls WHERE agent_id = ${agentId}`);
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

async function ceilings() {
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ d: agents.budgetDailyUsd, m: agents.budgetMonthlyUsd, p: agents.budgetAlertPct })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ?? null;
  } finally {
    await close();
  }
}

test.describe('Agent budget @cap:voir-le-cout/ecran', () => {
  test('shows what the agent spent, sets a ceiling, warns, then says the pause', async ({
    page,
  }) => {
    await page.goto(`/agents/${agentId}/edit?tab=settings`);
    const section = page.getByTestId('agent-budget');
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId('agent-budget-spend')).toContainText('Spent today$4.50');
    await expect(section.getByTestId('agent-budget-status')).toHaveCount(0);

    // $5 a day: 90 % spent, past the 80 % warning.
    await section.getByTestId('agent-budget-daily').fill('5');
    await section.getByTestId('agent-budget-save').click();
    await expect.poll(ceilings).toEqual({ d: 5, m: 0, p: 80 });
    await expect(section.getByTestId('agent-budget-status')).toHaveText(
      '90% of the daily ceiling spent.',
    );

    // $4 a day: already past, the agent is paused until midnight.
    await section.getByTestId('agent-budget-daily').fill('4');
    await section.getByTestId('agent-budget-save').click();
    await expect.poll(ceilings).toEqual({ d: 4, m: 0, p: 80 });
    await expect(section.getByTestId('agent-budget-status')).toHaveText(
      "Daily ceiling reached: this agent's runs stop until midnight. They keep what they wrote.",
    );
  });
});
