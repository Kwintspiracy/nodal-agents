/**
 * An owner settles, tool by tool, what an agent may do alone and what it must ask for first.
 *
 * Playwright e2e — the Approvals tab in the agent editor.
 *
 * Strategy: navigate to the existing /agents list, find the first existing agent
 * (created by the real user), and verify the Autonomy tab is present and functional.
 * We do NOT create a new agent (the e2e sentinel user has no LLM keys, so agent
 * creation is blocked). Instead we read-only test against an existing agent.
 *
 * Verifies:
 *  1. The "Autonomy" tab is visible in the agent editor for any agent.
 *  2. The tab renders without JS errors (empty state or tool list).
 *  3. If a write/destructive tool is visible, the 3-way controls are present.
 *  4. Toggling a control calls setAgentApprovalRuleAction + persists to DB
 *     (tested in the connector-dependent sub-test; skipped when no write tools
 *     are assigned to the agent).
 *
 * All assertions target real rendered HTML + real DB rows — no call-count
 * assertions.
 *
 * Tab lookup uses role="tab", not role="button": the DS `Tabs` primitive
 * (components/ui/Tabs.tsx) renders each tab as a `role="tab"` div, because the
 * label+count content is richer than a bare <button>. This spec predates that
 * primitive and kept looking for buttons, so every assertion here failed on
 * "element(s) not found" long before it could test anything about autonomy.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  makeDbClient,
  pollDb,
  resolveActingUser,
  testSlugSuffix,
} from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

test.describe('Approvals tab @cap:regler-autonomie/ecran', () => {
  // Populated by the "find first agent" setup test.
  let firstAgentEditUrl: string | null = null;

  test('find an existing agent to navigate to', async ({ page }) => {
    await page.goto('/agents');
    // Wait for the page to fully load.
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    // Find any "edit" link pointing to /agents/<uuid>/edit.
    const editLinks = page.locator('a[href*="/agents/"][href$="/edit"]');
    const count = await editLinks.count();
    if (count === 0) {
      // No agents → the entire Autonomy tab test suite is meaningless, skip.
      test.skip(true, 'No agents found in the workspace — Autonomy tab tests skipped');
      return;
    }
    firstAgentEditUrl = await editLinks.first().getAttribute('href');
  });

  test('Autonomy tab is visible in the agent editor', async ({ page }) => {
    if (!firstAgentEditUrl) {
      test.skip(true, 'No agent edit URL found');
      return;
    }
    await page.goto(firstAgentEditUrl);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    // The tab bar should contain an "Autonomy" tab. It is labelled so since
    // d3ecc410 (#438, 25/09); before, it read « Approvals » and this suite
    // looked for that word.
    const autonomyTab = page.getByRole('tab', { name: /^autonomy$/i });
    await expect(autonomyTab).toBeVisible({ timeout: 10_000 });
  });

  test('Autonomy tab renders without errors (empty state or tool list)', async ({ page }) => {
    if (!firstAgentEditUrl) {
      test.skip(true, 'No agent edit URL found');
      return;
    }
    // "Without errors" is asserted, not assumed: an uncaught exception in the
    // page while the tab renders fails the case (review of #594). Console
    // messages are not counted: dev builds print warnings that are not faults.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(firstAgentEditUrl);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    // Click the Autonomy tab.
    await page.getByRole('tab', { name: /^autonomy$/i }).click();

    // Should show either the empty state OR the tool list — but never an error.
    const hasEmptyState = page
      .getByText(/no write or destructive tools are currently assigned/i)
      .isVisible();
    const hasToolList = page.locator('[data-testid="autonomy-tool-list"]').isVisible();

    // At least one of the two must be visible within 8 seconds.
    const [emptyVisible, toolListVisible] = await Promise.all([hasEmptyState, hasToolList]);

    if (!emptyVisible && !toolListVisible) {
      // Both false — give it more time in case the server action is slow.
      await expect(
        page
          .getByText(/no write or destructive tools are currently assigned/i)
          .or(page.locator('[data-testid="autonomy-tool-list"]')),
      ).toBeVisible({ timeout: 8_000 });
    }
    expect(pageErrors).toEqual([]);
  });

  test('3-way control is present and interactive when write tools exist', async ({ page }) => {
    if (!firstAgentEditUrl) {
      test.skip(true, 'No agent edit URL found');
      return;
    }
    await page.goto(firstAgentEditUrl);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await page.getByRole('tab', { name: /^autonomy$/i }).click();

    // Skip if there are no gateable tools (empty state agent).
    const toolList = page.locator('[data-testid="autonomy-tool-list"]');
    const hasTools = await toolList.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasTools) {
      test.skip(true, 'Agent has no assigned write/destructive tools — 3-way control test skipped');
      return;
    }

    // Find the first "Ask for approval" button in the tool list.
    const firstAskFirstBtn = toolList
      .locator('[data-testid^="autonomy-btn-"][data-testid$="-require_approval"]')
      .first();
    await expect(firstAskFirstBtn).toBeVisible({ timeout: 5_000 });

    // Derive the tool slug from the testid.
    const testId = await firstAskFirstBtn.getAttribute('data-testid');
    // testid = "autonomy-btn-<slug>-require_approval"
    const toolSlug = testId?.replace('autonomy-btn-', '').replace('-require_approval', '') ?? '';

    // Click "Ask for approval".
    await firstAskFirstBtn.click();

    // Wait for the server action to complete (button stops being disabled).
    await expect(firstAskFirstBtn).not.toBeDisabled({ timeout: 8_000 });

    // Reload to verify persistence.
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
    await page.getByRole('tab', { name: /^autonomy$/i }).click();

    // The "Ask for approval" button should still be the active selection.
    // We verify by checking that the button has the active styling (bg-warn class).
    const persistedBtn = page.locator(`[data-testid="autonomy-btn-${toolSlug}-require_approval"]`);
    await expect(persistedBtn).toBeVisible({ timeout: 8_000 });
    // The active state uses bg-warn/15 class — verify it's applied.
    await expect(persistedBtn).toHaveClass(/bg-warn/, { timeout: 5_000 });

    // Reset back to "Run without asking" (cleanup — don't leave a require_approval rule behind).
    const autoBtn = page.locator(`[data-testid="autonomy-btn-${toolSlug}-auto_approve"]`);
    await autoBtn.click();
    // Wait for the server action to finish.
    await expect(autoBtn).not.toBeDisabled({ timeout: 8_000 });
  });
});

/**
 * #917 — the owner's rule: as soon as an agent exists and a tool is available,
 * its autonomy is a row in the database, and the tab shows that row, the one
 * the gate applies. Its own agent, created before and deleted after.
 */
test.describe('every tool has its row, and the tab shows it (#917) @cap:regler-autonomie/ecran', () => {
  const SETTING = 'setting:replace_shared_file';
  let agentId = '';

  test.beforeAll(async () => {
    const acting = await resolveActingUser();
    const { agents } = await import('@nodal-agents/db');
    const { db, close } = makeDbClient();
    try {
      const [agent] = await db
        .insert(agents)
        .values({
          entityId: acting.entityId,
          name: `Autonomy Rows E2E ${testSlugSuffix()}`,
          slug: `e2e-rows-${testSlugSuffix()}`,
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
      await db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await close();
    }
  });

  /** The agent's rows valid everywhere, read from the database. */
  async function rowsOf(): Promise<Map<string, string>> {
    const { approvalRules, and, eq } = await import('@nodal-agents/db');
    const { db, close } = makeDbClient();
    try {
      const rows = await db
        .select({ toolName: approvalRules.toolName, action: approvalRules.action })
        .from(approvalRules)
        .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.conditionFolder, '')));
      return new Map(rows.map((r) => [r.toolName, r.action]));
    } finally {
      await close();
    }
  }

  test('opening the tab writes a row per tool, each control shows its row, and the shared-file setting is one of them', async ({
    page,
  }) => {
    expect((await rowsOf()).size).toBe(0);
    await page.goto(`/agents/${agentId}/edit?tab=autonomy`);
    await expect(page.locator('[data-testid="autonomy-internal-list"]')).toBeVisible({
      timeout: 30_000,
    });

    const rows = await rowsOf();
    expect(rows.size).toBeGreaterThan(10);
    for (const slug of ['file_read', 'file_write', 'file_move', SETTING]) {
      const action = rows.get(slug);
      expect(action, `${slug} has no row`).toBeDefined();
      await expect(page.getByTestId(`autonomy-btn-${slug}-${action}`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await expect(
      page.getByText('Replace or remove a shared file this agent did not create'),
    ).toBeVisible();

    // The owner changes the setting: the row reads back, and a reload shows it.
    const next = rows.get(SETTING) === 'auto_approve' ? 'require_approval' : 'auto_approve';
    await page.getByTestId(`autonomy-btn-${SETTING}-${next}`).click();
    expect(
      await pollDb(async () => ((await rowsOf()).get(SETTING) === next ? 'yes' : null), {
        timeoutMs: 15_000,
        intervalMs: 300,
      }),
    ).toBe('yes');
    await page.goto(`/agents/${agentId}/edit?tab=autonomy`);
    await expect(page.getByTestId(`autonomy-btn-${SETTING}-${next}`)).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 30_000 },
    );
  });
});
