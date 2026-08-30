/**
 * agent-recipes.spec.ts — "What should this agent do?" → one pre-filled agent.
 *
 * What is proven, on the REAL stack and against REAL rows:
 *
 *  1. "Start from scratch" comes FIRST and still opens the empty form; the
 *     "Development" is a family select — a name and a shape — with NO button that
 *     creates the whole team.
 *  2. Choosing "Code reviewer" opens a DETAIL panel first, naming what the
 *     profile sets: the skill it attaches, the tools it blocks (read-only),
 *     and what the user still has to provide. Only "Continue" reaches the
 *     ordinary create form, pre-filled and still editable.
 *  3. Submitting creates ONE agent; its skill (`code-review`) is attached and
 *     the five write tools are blocked — asserted on agent_skill_assignments
 *     and approval_rules.
 *  4. The agent is ordinary: no column on its row says it came from a profile.
 *
 * Cleanup deletes the agent it created (cascade removes assignments + rules).
 */

import { test, expect } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';
import { agents, agentSkills, agentSkillAssignments, approvalRules } from '@nodal-agents/db';
import { requireLiveStack, makeDbClient, testSlugSuffix } from './helpers';

test.describe('agent recipes', () => {
  test.beforeAll(async () => {
    await requireLiveStack();
  });

  test('a profile shows what it sets, then creates ONE ordinary agent with skills and read-only rules', async ({
    page,
  }) => {
    const db = makeDbClient();
    const suffix = testSlugSuffix();
    const slug = `code-reviewer-${suffix}`;
    const name = `Code reviewer ${suffix}`;

    try {
      await page.goto('/agents');
      await page.getByRole('button', { name: 'New agent' }).click();

      const picker = page.getByRole('dialog');
      await expect(picker.getByRole('heading', { name: 'Create New Agent' })).toBeVisible();

      // 1. Scratch first, as a radio card; the family is a select whose shape
      // is explained, with no build button. Counts on the card are real.
      const radios = picker.getByRole('radio');
      await expect(radios.first()).toContainText('Customize a new agent');
      await expect(radios.first()).toHaveAttribute('aria-checked', 'true');
      await expect(picker.getByLabel('Profile family')).toHaveValue('dev-team');
      await expect(picker.getByText('Team lead → Developer + Code reviewer')).toBeVisible();
      await expect(picker.getByRole('button', { name: /create (the )?team/i })).toHaveCount(0);
      const reviewer = picker.getByRole('radio', { name: /^Code reviewer/ });
      await expect(reviewer).toContainText('1 Skills');
      await expect(reviewer).toContainText('1 Connectors');
      await expect(reviewer).toContainText('5 tools blocked');

      // 2. Select → Next → the detail panel names what the profile sets,
      // BEFORE any form — including the connector and what it takes.
      await reviewer.click();
      await expect(reviewer).toHaveAttribute('aria-checked', 'true');
      await picker.getByRole('button', { name: 'Next' }).click();
      const detail = page.getByRole('dialog');
      await expect(detail.getByRole('heading', { name: 'Code reviewer' })).toBeVisible();
      await expect(detail.getByText('Skills attached (1)')).toBeVisible();
      await expect(detail.getByText('Code review', { exact: true })).toBeVisible();
      await expect(detail.getByText('Connectors recommended (1)')).toBeVisible();
      await expect(detail.getByText('Playwright', { exact: true })).toBeVisible();
      // A fresh install has no Playwright instance: the panel says it is the
      // user's move, and that no API key is involved.
      await expect(detail.getByText(/Not installed yet\.|Ready\./)).toBeVisible();
      await expect(detail.getByText('Read-only.')).toBeVisible();
      await expect(
        detail.getByText(
          /blocked: file_write, file_edit, skill_file_write, run_command, run_skill_script/,
        ),
      ).toBeVisible();
      await expect(detail.getByText('A folder of its own')).toBeVisible();
      // Not a form yet: no Name field on this screen.
      await expect(detail.getByLabel('Name')).toHaveCount(0);

      await detail.getByRole('button', { name: 'Continue' }).click();

      // …then the ordinary form, pre-filled and editable.
      const form = page.getByRole('dialog');
      await expect(
        form.getByRole('heading', { name: 'Create New Agent — Code reviewer' }),
      ).toBeVisible();
      await expect(form.getByLabel('Name')).toHaveValue('Code reviewer');
      await expect(form.getByLabel('Slug')).toHaveValue('code-reviewer');
      await form.getByLabel('Slug').fill(slug);
      await form.getByLabel('Name').fill(name);
      await form.getByLabel(/Personality/).fill('e2e profile test agent');

      // 3. Submit → one agent, skill attached, write tools blocked.
      await form.getByRole('button', { name: 'Create agent' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const created = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
      expect(created).toHaveLength(1);
      const agent = created[0]!;
      expect(agent.name).toBe(name);
      expect(agent.role).toBe('agent'); // a worker — the reviewer does not orchestrate

      const attached = await db
        .select({ slug: agentSkills.slug })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
        .where(eq(agentSkillAssignments.agentId, agent.id));
      expect(attached.map((r) => r.slug)).toEqual(['code-review']);

      const blocked = await db
        .select({ toolName: approvalRules.toolName, action: approvalRules.action })
        .from(approvalRules)
        .where(eq(approvalRules.agentId, agent.id));
      expect(blocked.every((r) => r.action === 'block')).toBe(true);
      expect(blocked.map((r) => r.toolName).sort()).toEqual([
        'file_edit',
        'file_write',
        'run_command',
        'run_skill_script',
        'skill_file_write',
      ]);

      // 4. Ordinary agent: nothing on the row says "profile". Asserted on the
      // column set, so a future provenance column fails here instead of
      // slipping in.
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

  test('"Customize a new agent" is selected by default and Next opens the empty form', async ({
    page,
  }) => {
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New agent' }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('radio', { name: /Customize a new agent/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await picker.getByRole('button', { name: 'Next' }).click();

    const form = page.getByRole('dialog');
    await expect(
      form.getByRole('heading', { name: 'Create New Agent', exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel('Name')).toHaveValue('');
    await expect(form.getByLabel('Slug')).toHaveValue('');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
