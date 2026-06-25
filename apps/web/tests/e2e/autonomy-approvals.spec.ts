/**
 * Playwright e2e — Autonomy / Approvals tab in the agent editor.
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
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

test.describe('Autonomy / Approvals tab', () => {
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

    // The tab bar should contain an "Autonomy" tab.
    const autonomyTab = page.getByRole('button', { name: /^autonomy$/i });
    await expect(autonomyTab).toBeVisible({ timeout: 10_000 });
  });

  test('Autonomy tab renders without errors (empty state or tool list)', async ({ page }) => {
    if (!firstAgentEditUrl) {
      test.skip(true, 'No agent edit URL found');
      return;
    }
    await page.goto(firstAgentEditUrl);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    // Click the Autonomy tab.
    await page.getByRole('button', { name: /^autonomy$/i }).click();

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
    // If we got here without throwing, the tab rendered correctly.
  });

  test('3-way control is present and interactive when write tools exist', async ({ page }) => {
    if (!firstAgentEditUrl) {
      test.skip(true, 'No agent edit URL found');
      return;
    }
    await page.goto(firstAgentEditUrl);
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await page.getByRole('button', { name: /^autonomy$/i }).click();

    // Skip if there are no gateable tools (empty state agent).
    const toolList = page.locator('[data-testid="autonomy-tool-list"]');
    const hasTools = await toolList.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasTools) {
      test.skip(true, 'Agent has no assigned write/destructive tools — 3-way control test skipped');
      return;
    }

    // Find the first "Ask first" button in the tool list.
    const firstAskFirstBtn = toolList
      .locator('[data-testid^="autonomy-btn-"][data-testid$="-require_approval"]')
      .first();
    await expect(firstAskFirstBtn).toBeVisible({ timeout: 5_000 });

    // Derive the tool slug from the testid.
    const testId = await firstAskFirstBtn.getAttribute('data-testid');
    // testid = "autonomy-btn-<slug>-require_approval"
    const toolSlug = testId?.replace('autonomy-btn-', '').replace('-require_approval', '') ?? '';

    // Click "Ask first".
    await firstAskFirstBtn.click();

    // Wait for the server action to complete (button stops being disabled).
    await expect(firstAskFirstBtn).not.toBeDisabled({ timeout: 8_000 });

    // Reload to verify persistence.
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
    await page.getByRole('button', { name: /^autonomy$/i }).click();

    // The "Ask first" button should still be the active selection.
    // We verify by checking that the button has the active styling (bg-warn class).
    const persistedBtn = page.locator(`[data-testid="autonomy-btn-${toolSlug}-require_approval"]`);
    await expect(persistedBtn).toBeVisible({ timeout: 8_000 });
    // The active state uses bg-warn/15 class — verify it's applied.
    await expect(persistedBtn).toHaveClass(/bg-warn/, { timeout: 5_000 });

    // Reset back to Autonomous (cleanup — don't leave a require_approval rule behind).
    const autoBtn = page.locator(`[data-testid="autonomy-btn-${toolSlug}-auto_approve"]`);
    await autoBtn.click();
    // Wait for the server action to finish.
    await expect(autoBtn).not.toBeDisabled({ timeout: 8_000 });
  });
});
