/**
 * Playwright e2e — per-tool control over the always-on built-in tools.
 *
 * The sixteen built-in tools every agent gets used to be invisible in the
 * dashboard: always on, never listed. The only way to restrain one was the
 * read-only preset, which blocks five write tools at once — there was no way to
 * say "this agent may read workspace files but must never search the web".
 *
 * Unlike autonomy-approvals.spec.ts, this suite never skips for lack of
 * fixtures: these tools exist for EVERY agent by definition, so the list is
 * always rendered. That is the point of testing here rather than only in unit
 * tests — the previous e2e coverage of this screen skips itself entirely on a
 * workspace with no connectors assigned.
 *
 * Asserts on rendered HTML and on state that SURVIVES A RELOAD — a control that
 * flips visually and forgets on refresh is exactly the bug worth catching.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

/** The tool this suite flips. Chosen because it is outward-reaching, so an
 *  owner restricting it is a realistic thing to want, and because blocking it
 *  cannot wedge anything else in the workspace. */
const TOOL = 'web_search';

async function openAutonomyTab(page: Page, editUrl: string): Promise<void> {
  await page.goto(editUrl);
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  await page.getByRole('tab', { name: /^autonomy$/i }).click();
  // The section is rendered after the rules load, not on first paint.
  await expect(page.locator('[data-testid="autonomy-internal-list"]')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Resolve an agent to work with, per test.
 *
 * Deliberately NOT a shared module-level variable set by a first "find an
 * agent" test: Playwright may run each test in a different worker, where that
 * variable is undefined — every later test then skips itself and the suite
 * reports green while having asserted nothing. That is worse than failing.
 */
async function firstAgentEditUrl(page: Page): Promise<string | null> {
  await page.goto('/agents');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  const editLinks = page.locator('a[href*="/agents/"][href$="/edit"]');
  if ((await editLinks.count()) === 0) return null;
  return editLinks.first().getAttribute('href');
}

test.describe('Built-in tools — per-tool controls', () => {
  test('the section lists the built-in tools, always — no fixtures needed', async ({ page }) => {
    const editUrl = await firstAgentEditUrl(page);
    if (!editUrl) {
      test.skip(true, 'No agents in this workspace');
      return;
    }
    await openAutonomyTab(page, editUrl);

    const list = page.locator('[data-testid="autonomy-internal-list"]');
    // Every always-on tool name is printed as a <code> under its label.
    for (const slug of ['web_search', 'file_read', 'file_write', 'save_memory', 'return_result']) {
      await expect(list.getByText(slug, { exact: true })).toBeVisible();
    }
  });

  test('return_result is shown but locked, with the reason', async ({ page }) => {
    const editUrl = await firstAgentEditUrl(page);
    if (!editUrl) {
      test.skip(true, 'No agents in this workspace');
      return;
    }
    await openAutonomyTab(page, editUrl);

    // Present — hiding it would leave an owner wondering what is not being said.
    const locked = page.locator('[data-testid="autonomy-locked-return_result"]');
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(/always on/i);

    // And genuinely uncontrollable: no Block button exists for it.
    await expect(page.locator('[data-testid="autonomy-btn-return_result-block"]')).toHaveCount(0);
  });

  test('blocking a built-in tool persists across a reload', async ({ page }) => {
    const editUrl = await firstAgentEditUrl(page);
    if (!editUrl) {
      test.skip(true, 'No agents in this workspace');
      return;
    }
    await openAutonomyTab(page, editUrl);

    const blockBtn = page.locator(`[data-testid="autonomy-btn-${TOOL}-block"]`);
    await expect(blockBtn).toBeVisible();
    await blockBtn.click();
    await expect(blockBtn).not.toBeDisabled({ timeout: 10_000 });

    // The assertion that matters: come back fresh and the rule is still there.
    await openAutonomyTab(page, editUrl);
    await expect(page.locator(`[data-testid="autonomy-btn-${TOOL}-block"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10_000 },
    );
  });

  test('and can be handed back — the restriction is reversible', async ({ page }) => {
    const editUrl = await firstAgentEditUrl(page);
    if (!editUrl) {
      test.skip(true, 'No agents in this workspace');
      return;
    }
    await openAutonomyTab(page, editUrl);

    // Also the cleanup for the test above: this suite runs against the real
    // workspace, so it must not leave an agent unable to search the web.
    const autoBtn = page.locator(`[data-testid="autonomy-btn-${TOOL}-auto_approve"]`);
    await autoBtn.click();
    await expect(autoBtn).not.toBeDisabled({ timeout: 10_000 });

    await openAutonomyTab(page, editUrl);
    await expect(page.locator(`[data-testid="autonomy-btn-${TOOL}-auto_approve"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 10_000 },
    );
  });
});
