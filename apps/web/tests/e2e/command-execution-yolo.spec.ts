/**
 * Playwright e2e — "Run commands" on the agent's Autonomy tab: the Yolo switch.
 *
 * REWRITTEN 24/09 (#464). The previous version was written for the 17/07 Tools
 * tab, where `command-execution` was a tool-group switch. Since 25/08 it is a
 * skill again (it carries a discipline: never install heavyweight software on
 * your own initiative — `apps/web/src/lib/skill-tool-groups.ts`), attached from
 * the Skills tab, and the Autonomy copy changed since (#382): the old journey
 * waited for a Tools switch and a heading that no longer exist, and failed at
 * its second step on every stack. It was not in the nightly measure, so nobody
 * saw it.
 *
 * What this journey proves, in a browser against the real database:
 *   1. without the skill, the Autonomy tab has no "Run commands" switch;
 *   2. attaching "Command execution" from the Skills tab makes it appear, with
 *      the sentence saying what really happens to a command (#464);
 *   3. turning Yolo on asks first in the in-app ConfirmDialog (never
 *      window.confirm); cancelling changes nothing;
 *   4. confirming writes the `run_command → auto_approve` rule (read back in
 *      the database) and survives a reload; turning it off removes the rule.
 *
 * Its own agent, created before and deleted after: no state leaks between runs.
 * Conventions: requireLiveStack() in beforeAll, storageState via the config.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  requireLiveStack,
  makeDbClient,
  pollDb,
  resolveActingUser,
  testSlugSuffix,
} from './helpers.ts';

test.describe.configure({ timeout: 120_000 });

let agentId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { agents } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Yolo E2E ${testSlugSuffix()}`,
        slug: `e2e-yolo-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Its rules and skill assignments go with it (cascade).
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

async function openTab(page: Page, tab: 'skills' | 'autonomy'): Promise<void> {
  await page.goto(`/agents/${agentId}/edit?tab=${tab}`);
  await expect(
    page.getByRole('tab', { name: tab === 'skills' ? /^Skills/ : /^Autonomy/ }),
  ).toBeVisible({
    timeout: 30_000,
  });
}

/** The agent's `run_command` rule action, or null when it has none. */
async function yoloRule(): Promise<string | null> {
  const { approvalRules, and, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.toolName, 'run_command')));
    return row?.action ?? null;
  } finally {
    await close();
  }
}

const yoloSwitch = (page: Page) =>
  page.getByTestId('command-execution-section').getByRole('switch');

test('Run commands: attach the skill, then Yolo asks first, writes its rule, and comes back off @cap:executer-une-commande/ecran', async ({
  page,
}) => {
  // 1. No skill, no switch.
  await openTab(page, 'autonomy');
  await expect(page.getByText('What it may do with a shell')).toBeVisible();
  await expect(page.getByText('Run commands without asking')).toHaveCount(0);

  // 2. Attach "Command execution" from the Skills tab.
  await openTab(page, 'skills');
  await page.getByRole('button', { name: '+ Attach skills' }).click();
  // The library modal carries its title as text, not as an accessible name.
  const dialog = page.getByRole('dialog').filter({ hasText: 'Attach skills' });
  await dialog.getByPlaceholder('Search installed skills…').fill('command-execution');
  await dialog.getByRole('button', { name: 'Attach', exact: true }).first().click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: '"Command execution" attached' }),
  ).toBeVisible({ timeout: 10_000 });

  await openTab(page, 'autonomy');
  await expect(page.getByText('Run commands without asking')).toBeVisible();
  // #464: the sentence says what really happens, never "asks by default".
  await expect(page.getByText('Commands ask for your approval by default.')).toHaveCount(0);
  const toggle = yoloSwitch(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // 3. Turning it on asks first; cancelling changes nothing.
  await toggle.click();
  const confirm = page.getByRole('dialog', { name: 'Enable Yolo mode?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await yoloRule()).toBeNull();

  // 4. Confirming writes the rule, and a reload reads it back.
  await toggle.click();
  await page
    .getByRole('dialog', { name: 'Enable Yolo mode?' })
    .getByRole('button', { name: 'Enable Yolo' })
    .click();
  expect(
    await pollDb(async () => ((await yoloRule()) === 'auto_approve' ? 'auto_approve' : null), {
      timeoutMs: 15_000,
      intervalMs: 300,
    }),
  ).toBe('auto_approve');
  await openTab(page, 'autonomy');
  await expect(yoloSwitch(page)).toHaveAttribute('aria-checked', 'true');

  // Off again: the rule is gone.
  await yoloSwitch(page).click();
  await pollDb(async () => ((await yoloRule()) === null ? true : null), {
    timeoutMs: 15_000,
    intervalMs: 300,
  });
  await openTab(page, 'autonomy');
  await expect(yoloSwitch(page)).toHaveAttribute('aria-checked', 'false');
});
