/**
 * Playwright e2e — OAuth flow for Google Drive (Brique 34 v3).
 *
 * In v3, the flow is:
 *   1. Click "Connect with Google" on the Google Drive card (opens wizard modal)
 *   2. Wizard is pre-loaded with Google type; fill clientId + clientSecret + name
 *   3. Wizard POSTs to /api/oauth/google-oauth/start → 302 → accounts.google.com
 *   4. Intercept the start POST, capture Location header, abort redirect
 *   5. Navigate to callback URL with mock code
 *   6. Callback persists a credential row, redirects to /connectors?connectorSlug=google-drive&credentialId=...
 *   7. Server auto-assigns credential to connector, redirects to /connectors?just_connected=google-drive
 *   8. OAuthNotify fires toast; connector shows CONNECTED status
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Clean up any credentials from previous runs so the card renders the wizard button.
  await cleanCredentialsByType('google-oauth');
});

test.describe('Google Drive OAuth flow (wizard-driven)', () => {
  test('connect via wizard → callback → connected status and toast', async ({ page, context }) => {
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

    // Find the Google Drive card.
    const driveCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Google Drive', level: 3 }) });
    await expect(driveCard).toBeVisible({ timeout: 10_000 });

    // If already connected, disconnect first.
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
      await page.reload();
      await expect(driveCard).toBeVisible({ timeout: 10_000 });
    }

    // ── 4. Click "Connect with Google" to open the wizard modal ─────────────
    const connectBtn = driveCard.getByRole('button', { name: /connect with google/i });
    await connectBtn.click();

    // Wizard should appear as a dialog.
    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // ── 5. Fill wizard form (type is pre-selected as Google) ─────────────────
    await wizard.locator('input[name="clientId"]').fill('test-google-client-id');
    await wizard.locator('input[name="clientSecret"]').fill('test-google-client-secret');
    // Optional display name
    const nameInput = wizard.locator('input[name="name"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill('My Google Drive (e2e)');
    }

    // ── 6. Intercept the /start POST — forward to server, capture Location header
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

    // ── 7. Submit the wizard form ────────────────────────────────────────────
    const continueBtn = wizard.getByRole('button', { name: /continue with google/i });
    await continueBtn.click();

    await page.waitForTimeout(2_000);

    // ── 8. Navigate to the callback URL with mock code ────────────────────────
    expect(capturedRedirectUri).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-google-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 9. Should land back on /connectors (via auto-assignment redirect) ────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 10. Assert toast or connected status ─────────────────────────────────
    // Either a success toast appears, or the card shows "connected".
    await expect(page.getByText(/google drive/i).first()).toBeVisible({ timeout: 10_000 });

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
