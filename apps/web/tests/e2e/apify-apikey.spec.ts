/**
 * Playwright e2e — Apify api_key connector smoke test (multi-instance UI).
 *
 * Apify uses the simple api_key auth flow. This test confirms:
 *  1. The Apify card appears in the Marketplace section.
 *  2. Clicking "Install" (or "Add account") opens a Modal dialog with name +
 *     apiKey fields directly visible — no secondary expand step.
 *  3. Submitting creates an Active Connector instance with the given name.
 *  4. The instance is cleaned up via the Active list's Delete button + ConfirmDialog.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

const CONNECTOR_LABEL = 'Apify';
const INSTANCE_NAME = 'Apify — e2e smoke';
const TEST_API_KEY = 'apify_api_e2e_test_key_12345678';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

test.describe('Apify api_key connector smoke test', () => {
  test('marketplace card opens modal; connect with name + apiKey creates active instance', async ({
    page,
  }) => {
    // ── 0. Pre-cleanup: delete any leftover instance from a prior run ────────────
    await page.goto('/connectors');
    await page.waitForLoadState('networkidle');

    async function deleteIfPresent(name: string) {
      const activeSectionEl = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
      });
      if (!(await activeSectionEl.isVisible().catch(() => false))) return;

      const instanceCard = activeSectionEl
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name, level: 3, exact: true }) })
        .first();

      if (!(await instanceCard.isVisible().catch(() => false))) return;

      const deleteBtn = instanceCard.getByRole('button', { name: /^delete$/i });
      if (!(await deleteBtn.isVisible().catch(() => false))) return;

      await deleteBtn.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(page.getByText(`${name} removed`)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
    }

    await deleteIfPresent(INSTANCE_NAME);

    await page.reload();
    await page.waitForLoadState('networkidle');

    // ── 1. Find the Apify Marketplace card ──────────────────────────────────────
    // Scope to the Marketplace <section> to avoid matching Active Connector cards.
    const marketplaceSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Marketplace', level: 2 }),
    });

    await expect(marketplaceSection).toBeVisible({ timeout: 10_000 });

    const marketplaceCard = marketplaceSection
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: CONNECTOR_LABEL, level: 3, exact: true }) });

    await expect(marketplaceCard).toBeVisible({ timeout: 10_000 });

    // ── 2. Click "Install" — opens the Modal portal ──────────────────────────────
    await marketplaceCard.getByRole('button', { name: /^install$/i }).click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });

    const nameInput = dialog.locator('input[name="name"]');
    const apiKeyInput = dialog.locator('input[name="apiKey"]');

    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });

    // ── 3. Fill name + api key ───────────────────────────────────────────────────
    await nameInput.fill(INSTANCE_NAME);
    await apiKeyInput.fill(TEST_API_KEY);

    // ── 4. Submit ────────────────────────────────────────────────────────────────
    await dialog.getByRole('button', { name: /^connect$/i }).click();

    // ── 5. Assert success toast ──────────────────────────────────────────────────
    // ConnectorAddForm toasts "${name} connected" on success.
    await expect(page.getByText(`${INSTANCE_NAME} connected`)).toBeVisible({ timeout: 10_000 });

    // Wait for the modal portal to unmount (onDone closes the Modal).
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // ── 6. Reload and assert instance appears in Active Connectors ───────────────
    await page.reload();
    await page.waitForLoadState('networkidle');

    const activeSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
    });

    await expect(activeSection).toBeVisible({ timeout: 10_000 });
    await expect(activeSection.getByRole('heading', { name: INSTANCE_NAME, level: 3 })).toBeVisible(
      { timeout: 10_000 },
    );

    // ── 7. Clean up: delete the created instance ─────────────────────────────────
    const activeSectionLoc = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Active Connectors', level: 2 }),
    });
    const instanceCard = activeSectionLoc
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: INSTANCE_NAME, level: 3, exact: true }) })
      .first();

    await instanceCard.getByRole('button', { name: /^delete$/i }).click();

    const dialog2 = page.getByRole('dialog');
    await dialog2.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog2.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText(`${INSTANCE_NAME} removed`)).toBeVisible({ timeout: 10_000 });
  });
});
