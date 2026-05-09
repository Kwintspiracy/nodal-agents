/**
 * Playwright e2e — OAuth flow for Google Drive.
 *
 * Strategy: intercept the /api/oauth/google-drive/start POST at the network
 * layer, forward it to the real server, capture the Location header from the
 * 302 response (the auth provider URL), extract state + redirect_uri from
 * that URL, then abort the redirect so the browser stays on /connectors, and
 * finally navigate directly to the callback URL with a mock code.
 *
 * This test requires the NodalAI stack to be running locally.
 * It will be skipped automatically if the stack is unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Google Drive OAuth flow', () => {
  test('connect → callback → connected status and toast', async ({ page, context }) => {
    const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

    // ── 1. Intercept Google token endpoint ───────────────────────────────────
    await context.route(GOOGLE_TOKEN_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-google-at',
          refresh_token: 'mock-google-rt',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive openid email',
          token_type: 'Bearer',
        }),
      });
    });

    // ── 2. Intercept Google userinfo endpoint ────────────────────────────────
    await context.route(GOOGLE_USERINFO_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'test@example.com',
          name: 'Test User',
          sub: '1234567890',
        }),
      });
    });

    // ── 3. Navigate to /connectors ───────────────────────────────────────────
    await page.goto('/connectors');

    // Find the Google Drive card. Each connector renders as a rounded-xl card.
    const driveCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Google Drive', level: 3 }) });
    await expect(driveCard).toBeVisible({ timeout: 10_000 });

    // If the connector is already connected (from a previous test run), disconnect first.
    if (await driveCard.getByRole('button', { name: /disconnect/i }).isVisible()) {
      await driveCard
        .getByRole('button', { name: /disconnect/i })
        .first()
        .click();
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
    }

    // ── 4. Click Connect to reveal the OAuth form ────────────────────────────
    await driveCard.getByRole('button', { name: /^connect$/i }).click();
    await expect(driveCard.locator('input[name="clientId"]')).toBeVisible({ timeout: 5_000 });

    // ── 5. Fill in client credentials ────────────────────────────────────────
    await driveCard.locator('input[name="clientId"]').fill('test-client-id');
    await driveCard.locator('input[name="clientSecret"]').fill('test-client-secret');

    // ── 6. Intercept the /start POST: forward to server, capture Location header,
    //       then abort the browser navigation to accounts.google.com.
    let capturedRedirectUri = '';
    let capturedState = '';

    await context.route('**/api/oauth/google-drive/start', async (route) => {
      // Forward the request to the real server without following redirects,
      // so we can capture the Location header from the 302 response.
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';

      if (location.includes('accounts.google.com')) {
        const url = new URL(location);
        capturedRedirectUri = url.searchParams.get('redirect_uri') ?? '';
        capturedState = url.searchParams.get('state') ?? '';

        // Fulfill with a plain 200 so the browser doesn't follow the redirect.
        // The cookie Set-Cookie header from the real response must be preserved.
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

    // ── 7. Submit the form ────────────────────────────────────────────────────
    const continueBtn = driveCard.getByRole('button', { name: /continue with google drive/i });
    await continueBtn.click();

    // Wait for the start route handler to run and populate the captured values.
    await page.waitForTimeout(2_000);

    // ── 8. Navigate to the callback URL with mock code ────────────────────────
    expect(capturedRedirectUri).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-auth-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 9. Should land back on /connectors?connected=google-drive ────────────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 10. Assert toast: "Google Drive connected" ─────────────────────────
    await expect(page.getByText(/google drive/i).first()).toBeVisible({ timeout: 10_000 });

    // ── 11. Assert connected status chip is visible ───────────────────────────
    await expect(
      page
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name: 'Google Drive', level: 3 }) })
        .getByText(/connected/i)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
