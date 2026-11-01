/**
 * Playwright e2e — "Run commands" on the agent's Autonomy tab.
 *
 * REWRITTEN 24/09 (#464), then for #468: the Yolo switch became the same three
 * choices as every other tool (Run without asking / Ask for approval / Block).
 * Since #917 `run_command` has a row like every tool: no "no rule" state.
 *
 * What this journey proves, in a browser against the real database:
 *   1. without the skill, the Autonomy tab has no "Run commands" row;
 *   2. attaching "Command execution" from the Skills tab makes it appear, with
 *      the choice its row holds lit, and that row in the database;
 *   3. "Run without asking" asks first in the in-app ConfirmDialog (never
 *      window.confirm); cancelling writes nothing;
 *   4. Block writes the `run_command → block` row (read back in the
 *      database) and a reload shows it lit; Ask writes `require_approval`;
 *   5. the floor no setting lifts is said on the row.
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
        name: `Run Commands E2E ${testSlugSuffix()}`,
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

/** The agent's `run_command` row, or null when it has none. */
async function yoloRule(): Promise<string | null> {
  const { approvalRules, and, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'run_command'),
          eq(approvalRules.conditionFolder, ''),
        ),
      );
    return row?.action ?? null;
  } finally {
    await close();
  }
}

const choice = (page: Page, action: 'auto_approve' | 'require_approval' | 'block') =>
  page.getByTestId(`autonomy-btn-run_command-${action}`);

/** Waits until the database holds `expected` as the agent's rule. */
async function ruleBecomes(expected: string | null): Promise<void> {
  expect(
    await pollDb(async () => ((await yoloRule()) === expected ? 'yes' : null), {
      timeoutMs: 15_000,
      intervalMs: 300,
    }),
  ).toBe('yes');
}

test('Run commands: its row is lit, Block reads back, and the floor is said @cap:executer-une-commande/ecran', async ({
  page,
}) => {
  // 1. No skill, no row.
  await openTab(page, 'autonomy');
  await expect(page.getByText('What it may do with a shell')).toBeVisible();
  await expect(page.getByText('Run commands on this machine')).toHaveCount(0);

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
  await expect(page.getByText('Run commands on this machine')).toBeVisible();
  // #464: the sentence says what really happens, never "asks by default".
  await expect(page.getByText('Commands ask for your approval by default.')).toHaveCount(0);
  // #917: the row exists, and the lit choice is that row. No "no choice" state.
  await expect(page.getByTestId('run-command-no-rule')).toHaveCount(0);
  const written = await yoloRule();
  expect(written).not.toBeNull();
  await expect(choice(page, written as 'auto_approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('autonomy-note-run_command')).toContainText(
    'always asks, whatever this setting says',
  );

  // Start from Ask, whatever the level wrote, for the confirmation below.
  if (written !== 'require_approval') {
    await choice(page, 'require_approval').click();
    await ruleBecomes('require_approval');
  }

  // 3. "Run without asking" asks first; cancelling writes nothing.
  await choice(page, 'auto_approve').click();
  const confirm = page.getByRole('dialog', { name: 'Run commands without asking?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(choice(page, 'auto_approve')).toHaveAttribute('aria-pressed', 'false');
  expect(await yoloRule()).toBe('require_approval');

  // 4. Block writes its rule, and a reload shows it.
  await choice(page, 'block').click();
  await ruleBecomes('block');
  await openTab(page, 'autonomy');
  await expect(choice(page, 'block')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('This agent cannot run commands.')).toBeVisible();

  await choice(page, 'require_approval').click();
  await ruleBecomes('require_approval');

  // 5. There is nothing to remove: a tool always has its row.
  await expect(page.getByTestId('run-command-reset')).toHaveCount(0);
});
