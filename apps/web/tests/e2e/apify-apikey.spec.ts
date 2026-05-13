/**
 * Playwright e2e — Apify api_key connector smoke test (Brique 34 v3).
 *
 * Apify uses the simple api_key auth flow (same as Notion internal).
 * This test confirms the new catalog entry renders correctly and the
 * api_key connect flow works end-to-end.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Apify api_key connector smoke test', () => {
  test('catalog entry renders; connect with api_key shows connected', async ({ page }) => {
    // ── 1. Navigate to /connectors ───────────────────────────────────────────
    await page.goto('/connectors');

    // Find the Apify card.
    const apifyCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Apify', level: 3 }) });
    await expect(apifyCard).toBeVisible({ timeout: 10_000 });

    // Disconnect if already connected.
    const disconnectBtn = apifyCard.getByRole('button', { name: /disconnect/i });
    if (await disconnectBtn.isVisible()) {
      await disconnectBtn.click();
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
      await page.reload();
      await expect(apifyCard).toBeVisible({ timeout: 10_000 });
    }

    // ── 2. Click Connect ──────────────────────────────────────────────────────
    await apifyCard.getByRole('button', { name: /^connect$/i }).click();

    // The api_key input should appear (no wizard for api_key connectors).
    const apiKeyInput = apifyCard.locator('input[name="apiKey"]');
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });

    // No wizard dialog should have opened.
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // ── 3. Fill in test api key ───────────────────────────────────────────────
    const TEST_API_KEY = 'apify_api_e2e_test_key_12345678';
    await apiKeyInput.fill(TEST_API_KEY);

    // ── 4. Submit ─────────────────────────────────────────────────────────────
    await apifyCard.getByRole('button', { name: /^connect$/i }).click();

    // ── 5. Assert success toast ───────────────────────────────────────────────
    await expect(page.getByText(/apify connected/i)).toBeVisible({ timeout: 10_000 });

    // ── 6. Assert connected status chip ──────────────────────────────────────
    await expect(apifyCard.getByText(/connected/i).first()).toBeVisible({ timeout: 10_000 });

    // ── 7. No OAuth-specific controls (api_key connector) ────────────────────
    await expect(apifyCard.getByRole('button', { name: /refresh now/i })).not.toBeVisible();
    await expect(apifyCard.getByRole('button', { name: /reconnect/i })).not.toBeVisible();
  });
});
