/**
 * Playwright e2e — Credential reuse across multiple connectors (Brique 34 v3).
 *
 * Scenario:
 *   1. Create a Google credential via the Google Drive wizard
 *   2. The credential appears in the Google Drive dropdown after the flow
 *   3. Connect Gmail using the SAME credential (dropdown select → Save, no re-OAuth)
 *   4. Both connectors show CONNECTED with the same credential
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Clean up any credentials from previous runs so the Drive card renders the wizard button
  // and Gmail shows no compatible credentials initially.
  await cleanCredentialsByType('google-oauth');
});

test.describe('Credential reuse — Drive + Gmail share one Google credential', () => {
  test('connect Drive via wizard → reuse credential for Gmail via dropdown', async ({
    page,
    context,
  }) => {
    const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

    // ── 1. Mock Google external endpoints ─────────────────────────────────
    await context.route(GOOGLE_TOKEN_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-reuse-at',
          refresh_token: 'mock-reuse-rt',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive openid email',
          token_type: 'Bearer',
        }),
      });
    });

    await context.route(GOOGLE_USERINFO_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'reuse@example.com',
          name: 'Reuse Test',
          sub: '9999999999',
        }),
      });
    });

    // ── 2. Navigate to /connectors, disconnect Drive + Gmail if connected ──
    await page.goto('/connectors');

    for (const name of ['Google Drive', 'Gmail']) {
      const card = page
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name, level: 3 }) });
      if (await card.getByRole('button', { name: /disconnect/i }).isVisible()) {
        await card
          .getByRole('button', { name: /disconnect/i })
          .first()
          .click();
        await page
          .getByRole('button', { name: /disconnect/i })
          .last()
          .click();
        await page.waitForTimeout(800);
        await page.reload();
      }
    }

    // ── 3. Connect Google Drive via wizard ────────────────────────────────
    const driveCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Google Drive', level: 3 }) });
    await expect(driveCard).toBeVisible({ timeout: 10_000 });

    await driveCard.getByRole('button', { name: /connect with google/i }).click();

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    await wizard.locator('input[name="clientId"]').fill('reuse-client-id');
    await wizard.locator('input[name="clientSecret"]').fill('reuse-client-secret');
    const nameInput = wizard.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill('My Google (reuse test)');
    }

    // ── 4. Intercept /start → capture state ──────────────────────────────
    let capturedRedirectUri = '';
    let capturedState = '';

    await context.route('**/api/oauth/google-oauth/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';

      if (location.includes('accounts.google.com')) {
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

    await wizard.getByRole('button', { name: /continue with google/i }).click();
    await page.waitForTimeout(2_000);

    expect(capturedRedirectUri).toBeTruthy();
    expect(capturedState).toBeTruthy();

    // ── 5. Complete Drive callback ────────────────────────────────────────
    const callbackUrl = `${capturedRedirectUri}?code=mock-reuse-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // Drive must now be connected.
    await expect(driveCard.getByText(/connected/i).first()).toBeVisible({ timeout: 10_000 });

    // ── 6. Connect Gmail using the EXISTING credential (dropdown) ──────────
    const gmailCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Gmail', level: 3 }) });
    await expect(gmailCard).toBeVisible({ timeout: 10_000 });

    // Gmail should show "Connect" since there's now a compatible credential.
    const gmailConnectBtn = gmailCard.getByRole('button', { name: /^connect$/i });
    await gmailConnectBtn.click();

    // The credential dropdown should appear (not the wizard).
    const credentialSelect = gmailCard.locator('select');
    await expect(credentialSelect).toBeVisible({ timeout: 5_000 });

    // It should contain the credential we just created.
    const credentialNames = await credentialSelect.locator('option').allTextContents();
    expect(
      credentialNames.some(
        (n) => n.includes('My Google (reuse test)') || n.includes('reuse@example.com'),
      ),
    ).toBe(true);

    // Select the first option (our credential) and save.
    await gmailCard.getByRole('button', { name: /^save$/i }).click();

    // ── 7. Gmail must now show connected ──────────────────────────────────
    await expect(gmailCard.getByText(/connected/i).first()).toBeVisible({ timeout: 10_000 });

    // ── Cleanup ───────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
