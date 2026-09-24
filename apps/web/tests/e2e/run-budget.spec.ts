/**
 * run-budget.spec.ts — le budget de run de l'espace, et l'attente du premier
 * mot d'un agent, réglés à l'écran et relus en base (#442).
 *
 * Ce que ce parcours prouve, au navigateur et dans la base :
 *  - Settings → Safety montre le budget de run avec les défauts qui ne
 *    changent rien (2 $, aucune limite de temps) ; en poser un autre l'écrit
 *    dans `entities`, et la phrase de la section le dit ;
 *  - « Repair turns » est sur la même page (un filtre en double l'en écartait) ;
 *  - l'onglet Settings d'un agent écrit `agents.idle_timeout_seconds`, et le
 *    vider remet la décision à la plateforme (NULL).
 *
 * L'espace est rendu à ses défauts après le parcours ; l'agent est créé pour
 * lui et supprimé après.
 */

import { test, expect } from '@playwright/test';
import { eq, agents, entities } from '@nodal-agents/db';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

let entityId = '';
let agentId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  entityId = acting.entityId;
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId,
        name: `Slow Thinker ${testSlugSuffix()}`,
        slug: `e2e-slow-thinker-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  const { db, close } = makeDbClient();
  try {
    if (entityId) {
      await db
        .update(entities)
        .set({ maxRunCostUsd: 2, maxRunHours: 0 })
        .where(eq(entities.id, entityId));
    }
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

async function budget() {
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ cost: entities.maxRunCostUsd, hours: entities.maxRunHours })
      .from(entities)
      .where(eq(entities.id, entityId));
    return row ?? null;
  } finally {
    await close();
  }
}

async function firstTokenWait() {
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ s: agents.idleTimeoutSeconds })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.s ?? null;
  } finally {
    await close();
  }
}

test.describe('Run budget @cap:suivre-execution/ecran', () => {
  test('the workspace sets what a run may cost and how long it may work', async ({ page }) => {
    await page.goto('/settings?page=safety');
    const section = page.getByTestId('setting-section-run-budget');
    await expect(section).toBeVisible({ timeout: 30_000 });
    // Sa voisine « Repair turns » (#392) n'apparaissait sur AUCUNE page : un
    // second filtre d'identifiants l'écartait. Elle est là, à côté.
    await expect(page.getByTestId('setting-section-repair-turns')).toBeVisible();
    await expect(section.getByTestId('run-budget-sentence')).toHaveText(
      'A run stops once it has cost $2.00. It keeps what it wrote, and says why it stopped.',
    );

    await section.getByTestId('run-budget-cost').fill('5');
    await section.getByTestId('run-budget-hours').fill('1.5');
    await section.getByTestId('run-budget-save').click();

    await expect.poll(budget).toEqual({ cost: 5, hours: 1.5 });
    await expect(section.getByTestId('run-budget-sentence')).toHaveText(
      'A run stops once it has cost $5.00 or after 1.5 h of work. It keeps what it wrote, and says why it stopped.',
    );
  });

  test('an agent gets its own wait for the first word, and gives it back', async ({ page }) => {
    await page.goto(`/agents/${agentId}/edit?tab=settings`);
    const field = page.getByTestId('first-token-wait');
    await expect(field).toBeVisible({ timeout: 30_000 });

    await field.getByTestId('first-token-wait-input').fill('600');
    await field.getByTestId('first-token-wait-save').click();
    await expect.poll(firstTokenWait).toBe(600);
    await expect(field.getByText('Set for this agent: 600 s', { exact: false })).toBeVisible();

    await field.getByTestId('first-token-wait-input').fill('');
    await field.getByTestId('first-token-wait-save').click();
    await expect.poll(firstTokenWait).toBeNull();
  });
});
