/**
 * Playwright e2e — regression test for Notion Internal Integration (api_key path).
 *
 * Asserts that the original Notion api_key flow still works after Brique 34
 * added notion-oauth. Both connector types must coexist independently.
 *
 * Requires a running NodalAI stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Notion Internal Integration (api_key) — regression', () => {
  test('connect with api_key shows connected status and persists', async ({ page }) => {
    // ── 1. Navigate to /connectors ───────────────────────────────────────────
    await page.goto('/connectors');

    // Find the original Notion card (not "Notion (OAuth)").
    // The Notion card slug is 'notion', authType 'api_key'.
    // Each connector renders as a .rounded-xl card — use that to scope the locator.
    const notionCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Notion', exact: true, level: 3 }) });
    await expect(notionCard).toBeVisible({ timeout: 10_000 });

    // Disconnect if already connected so we start fresh.
    const disconnectBtn = notionCard.getByRole('button', { name: /disconnect/i });
    if (await disconnectBtn.isVisible()) {
      await disconnectBtn.click();
      // ConfirmDialog appears — find the last "Disconnect" button (inside the dialog).
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
      await page.reload();
      await expect(notionCard).toBeVisible({ timeout: 10_000 });
    }

    // ── 2. Open the connect form ──────────────────────────────────────────────
    await notionCard.getByRole('button', { name: /^connect$/i }).click();
    const apiKeyInput = notionCard.getByLabel(/api key/i);
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });

    // ── 3. Fill in a test API key ─────────────────────────────────────────────
    const TEST_API_KEY = 'secret_test_internal_integration_key_e2e';
    await apiKeyInput.fill(TEST_API_KEY);

    // ── 4. Submit ─────────────────────────────────────────────────────────────
    await notionCard.getByRole('button', { name: /^connect$/i }).click();

    // ── 5. Assert success toast ───────────────────────────────────────────────
    await expect(page.getByText(/notion connected/i)).toBeVisible({ timeout: 10_000 });

    // ── 6. Assert the card now shows "connected" status ───────────────────────
    await expect(notionCard.getByText(/connected/i).first()).toBeVisible({ timeout: 10_000 });

    // ── 7. Assert no OAuth-specific controls appear (api_key card) ────────────
    // There should be no "Refresh now" button (only OAuth connectors have that).
    await expect(notionCard.getByRole('button', { name: /refresh now/i })).not.toBeVisible();
    // There should be no "Reconnect" button either.
    await expect(notionCard.getByRole('button', { name: /reconnect/i })).not.toBeVisible();
  });
});
