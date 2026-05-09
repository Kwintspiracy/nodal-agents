/**
 * Playwright e2e — Airtable OAuth flow (Brique 34 v3).
 *
 * Airtable uses PKCE S256 + Basic auth on the token endpoint.
 * Flow mirrors Google Drive but uses the airtable-oauth-specific paths.
 *
 * Requires a running NodalAI stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Clean up any credentials from previous runs so the card renders the wizard button.
  await cleanCredentialsByType('airtable-oauth');
});

test.describe('Airtable OAuth flow (wizard-driven)', () => {
  test('connect via wizard → callback → connected status', async ({ page, context }) => {
    const AIRTABLE_TOKEN_URL = 'https://airtable.com/oauth2/v1/token';
    const AIRTABLE_WHOAMI_URL = 'https://api.airtable.com/v0/meta/whoami';

    // ── 1. Intercept Airtable token endpoint ─────────────────────────────────
    await context.route(AIRTABLE_TOKEN_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-airtable-at',
          refresh_token: 'mock-airtable-rt',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      });
    });

    // ── 2. Intercept Airtable whoami endpoint ────────────────────────────────
    await context.route(AIRTABLE_WHOAMI_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'airtable-user@example.com', id: 'usrMock123' }),
      });
    });

    // ── 3. Navigate to /connectors ───────────────────────────────────────────
    await page.goto('/connectors');

    const airtableCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Airtable (OAuth)', level: 3 }) });
    await expect(airtableCard).toBeVisible({ timeout: 10_000 });

    // Disconnect if already connected.
    if (await airtableCard.getByRole('button', { name: /disconnect/i }).isVisible()) {
      await airtableCard
        .getByRole('button', { name: /disconnect/i })
        .first()
        .click();
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
      await page.reload();
      await expect(airtableCard).toBeVisible({ timeout: 10_000 });
    }

    // ── 4. Click "Connect with Airtable" to open the wizard modal ───────────
    await airtableCard.getByRole('button', { name: /connect with airtable/i }).click();

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // ── 5. Fill wizard form ───────────────────────────────────────────────────
    await wizard.locator('input[name="clientId"]').fill('airtable-test-client-id');
    await wizard.locator('input[name="clientSecret"]').fill('airtable-test-client-secret');
    const nameInput = wizard.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill('My Airtable (e2e)');
    }

    // ── 6. Intercept /start POST ──────────────────────────────────────────────
    let capturedRedirectUri = '';
    let capturedState = '';

    await context.route('**/api/oauth/airtable-oauth/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';

      if (location.includes('airtable.com')) {
        const url = new URL(location);
        capturedRedirectUri = url.searchParams.get('redirect_uri') ?? '';
        capturedState = url.searchParams.get('state') ?? '';

        const setCookie = response.headers()['set-cookie'] ?? '';
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: setCookie ? { 'set-cookie': setCookie } : {},
          body: '<html><body>intercepted</body></html>',
        });
      } else {
        await route.fulfill({ response });
      }
    });

    // ── 7. Submit wizard ──────────────────────────────────────────────────────
    await wizard.getByRole('button', { name: /continue with airtable/i }).click();
    await page.waitForTimeout(2_000);

    // ── 8. Navigate to callback with mock code ────────────────────────────────
    expect(capturedRedirectUri).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-airtable-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 9. Should land on /connectors ────────────────────────────────────────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 10. Assert connected status ───────────────────────────────────────────
    // Use exact text match to avoid matching the substring "connected" inside "disconnected".
    await expect(
      page
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name: 'Airtable (OAuth)', level: 3 }) })
        .getByText('connected', { exact: true })
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Airtable supports refresh — check the "Refresh now" button appears.
    await expect(
      page
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name: 'Airtable (OAuth)', level: 3 }) })
        .getByRole('button', { name: /refresh now/i }),
    ).toBeVisible({ timeout: 5_000 });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
