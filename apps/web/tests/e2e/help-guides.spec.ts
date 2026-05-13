/**
 * Playwright e2e — Brique 34 v3.1: help guide smoke tests.
 *
 * Scenario A: Google Drive wizard shows all 4 API direct links + format hint.
 * Scenario B: Apify connector "Where do I get this?" expander reveals the
 *             console.apify.com link.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Ensure Google Drive shows the "Connect with Google" wizard button.
  await cleanCredentialsByType('google-oauth');
});

test.describe('Help guides — OAuth wizard (Google Drive)', () => {
  test('wizard shows 4 Google API links and format hint', async ({ page }) => {
    await page.goto('/connectors');

    // Find the Google Drive card.
    const driveCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Google Drive', level: 3 }) });
    await expect(driveCard).toBeVisible({ timeout: 10_000 });

    // If already connected, disconnect first so the wizard button appears.
    const disconnectBtn = driveCard.getByRole('button', { name: /disconnect/i });
    if (await disconnectBtn.isVisible()) {
      await disconnectBtn.click();
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
      await page.reload();
      await expect(driveCard).toBeVisible({ timeout: 10_000 });
    }

    // Click "Connect with Google" to open the wizard.
    const connectBtn = driveCard.getByRole('button', { name: /connect with google/i });
    await connectBtn.click();

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // ── Assert the 4 Google API direct links ──────────────────────────────────
    await expect(wizard.getByRole('link', { name: /drive api/i })).toBeVisible({ timeout: 5_000 });
    await expect(wizard.getByRole('link', { name: /gmail api/i })).toBeVisible();
    await expect(wizard.getByRole('link', { name: /sheets api/i })).toBeVisible();
    await expect(wizard.getByRole('link', { name: /docs api/i })).toBeVisible();

    // Verify the Drive API link points to the correct URL.
    const driveLink = wizard.getByRole('link', { name: /drive api/i });
    await expect(driveLink).toHaveAttribute(
      'href',
      'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    );

    // ── Assert the format hint contains apps.googleusercontent.com ────────────
    await expect(wizard.getByText(/apps\.googleusercontent\.com/)).toBeVisible();

    // Close the wizard via Escape key (close button may be off-screen due to tall guide).
    await page.keyboard.press('Escape');
    await expect(wizard).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Help guides — api_key connector (Apify)', () => {
  test('"Where do I get this?" expander reveals console.apify.com link', async ({ page }) => {
    await page.goto('/connectors');

    // Find the Apify card.
    const apifyCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Apify', level: 3 }) });
    await expect(apifyCard).toBeVisible({ timeout: 10_000 });

    // Disconnect if already connected so the Connect form is available.
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

    // Click Connect to open the api_key form.
    await apifyCard.getByRole('button', { name: /^connect$/i }).click();

    // The api_key input should be visible.
    await expect(apifyCard.locator('input[name="apiKey"]')).toBeVisible({ timeout: 5_000 });

    // The details summary should be present (collapsed by default — link not yet visible).
    const summary = apifyCard.getByText(/where do i get this\?/i);
    await expect(summary).toBeVisible();

    // The apify link should NOT be visible before expanding.
    const apifyLink = apifyCard.getByRole('link', { name: /console\.apify\.com/i });
    await expect(apifyLink).not.toBeVisible();

    // Click the summary to expand the details.
    await summary.click();

    // Now the link should be visible.
    await expect(apifyLink).toBeVisible({ timeout: 3_000 });
    await expect(apifyLink).toHaveAttribute(
      'href',
      'https://console.apify.com/account/integrations',
    );
  });
});
