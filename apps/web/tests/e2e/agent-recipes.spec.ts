/**
 * agent-recipes.spec.ts — "What should this agent do?" → one pre-filled agent.
 *
 * What is proven, on the REAL stack and against REAL rows:
 *
 *  1. The picker shows the Dev team as a suggestion — a name and a shape —
 *     and there is NO button that creates the whole team.
 *  2. Choosing "Développeur" opens the ordinary create form, pre-filled
 *     (name, slug) and still editable.
 *  3. Submitting creates ONE agent, and the recipe's skills (`dev`,
 *     `request-review`) are attached — asserted on agent_skill_assignments.
 *  4. The agent is ordinary: it has no column, flag or row that says it came
 *     from a recipe. Asserted by reading the agents row back.
 *  5. "Start from scratch" still opens the empty form.
 *
 * Cleanup deletes the agent it created (cascade removes the assignments).
 */

import { test, expect } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';
import { agents, agentSkills, agentSkillAssignments } from '@nodal-agents/db';
import { requireLiveStack, makeDbClient, testSlugSuffix } from './helpers';

test.describe('agent recipes', () => {
  test.beforeAll(async () => {
    await requireLiveStack();
  });

  test('a recipe pre-fills the form and creates ONE ordinary agent with its skills', async ({
    page,
  }) => {
    const db = makeDbClient();
    const suffix = testSlugSuffix();
    const slug = `developer-${suffix}`;
    const name = `Développeur ${suffix}`;

    try {
      await page.goto('/agents');
      await page.getByRole('button', { name: 'New agent' }).click();

      const picker = page.getByRole('dialog');
      await expect(
        picker.getByRole('heading', { name: 'What should this agent do?' }),
      ).toBeVisible();

      // 1. The team is a SUGGESTION: name + shape shown, nothing that builds it.
      await expect(picker.getByText('Dev team')).toBeVisible();
      await expect(picker.getByText('Chef d’équipe → Développeur + Relecteur')).toBeVisible();
      await expect(picker.getByRole('button', { name: /create (the )?team/i })).toHaveCount(0);
      await expect(picker.getByRole('button', { name: /Relecteur/ })).toBeVisible();
      await expect(picker.getByRole('button', { name: /Chef d’équipe/ })).toBeVisible();

      // 2. Choosing a recipe opens the ordinary form, pre-filled and editable.
      await picker.getByRole('button', { name: /^Développeur/ }).click();
      const form = page.getByRole('dialog');
      await expect(form.getByRole('heading', { name: 'New agent — Développeur' })).toBeVisible();
      await expect(form.getByLabel('Name')).toHaveValue('Développeur');
      await expect(form.getByLabel('Slug')).toHaveValue('developer');

      // Editable: the user renames before submitting (also keeps the test's
      // rows distinct from anything already in the workspace).
      await form.getByLabel('Slug').fill(slug);
      await form.getByLabel('Name').fill(name);
      await form.getByLabel(/Personality/).fill('e2e recipe test agent');

      // 3. Submit → one agent, with the recipe's skills attached.
      await form.getByRole('button', { name: 'Create agent' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const created = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
      expect(created).toHaveLength(1);
      const agent = created[0]!;
      expect(agent.name).toBe(name);
      expect(agent.role).toBe('agent'); // a worker — the developer does not orchestrate

      const attached = await db
        .select({ slug: agentSkills.slug })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
        .where(eq(agentSkillAssignments.agentId, agent.id));
      expect(attached.map((r) => r.slug).sort()).toEqual(['dev', 'request-review']);

      // 4. Ordinary agent: nothing on the row says "recipe". The assertion is
      // on the column set, so a future column that DOES record provenance
      // fails here instead of slipping in.
      const columns = Object.keys(agent);
      expect(columns.some((c) => /recipe|profile|template/i.test(c))).toBe(false);

      // Only ONE agent was created by the click.
      const withSuffix = await db
        .select({ id: agents.id })
        .from(agents)
        .where(sql`${agents.slug} LIKE ${'%' + suffix}`);
      expect(withSuffix).toHaveLength(1);
    } finally {
      await db.delete(agents).where(eq(agents.slug, slug));
    }
  });

  test('"Start from scratch" still opens the empty form', async ({ page }) => {
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New agent' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Start from scratch/ })
      .click();

    const form = page.getByRole('dialog');
    await expect(form.getByRole('heading', { name: 'New agent', exact: true })).toBeVisible();
    await expect(form.getByLabel('Name')).toHaveValue('');
    await expect(form.getByLabel('Slug')).toHaveValue('');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
