/**
 * Playwright e2e — OAuth flow for Notion (OAuth / Public Integration) — Brique 34 v3.
 *
 * In v3, the flow uses the credential wizard modal:
 *   1. Click "Connect with Notion" on the Notion (OAuth) card → wizard opens
 *   2. Fill clientId + clientSecret in the wizard
 *   3. Wizard POSTs to /api/oauth/notion-oauth/start
 *   4. Intercept, capture state, abort redirect
 *   5. Navigate to callback with mock code
 *   6. Callback creates a credential row, redirects to
 *      /connectors?connectorSlug=notion-oauth&credentialId=...
 *   7. Server auto-assigns + redirects to /connectors?just_connected=notion-oauth
 *   8. Card shows CONNECTED; no Refresh button (Notion supportsRefresh: false)
 *
 * Requires a running NodalAI stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, cleanCredentialsByType } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
  // Clean up any credentials from previous runs so the card renders the wizard button.
  await cleanCredentialsByType('notion-oauth');
});

test.describe('Notion OAuth flow (wizard-driven)', () => {
  test('connect via wizard → callback → connected status (no Refresh button)', async ({
    page,
    context,
  }) => {
    const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

    // ── 1. Intercept Notion token endpoint ───────────────────────────────────
    await context.route(NOTION_TOKEN_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-notion-at',
          bot_id: 'mock-bot-id',
          workspace_name: 'Test Workspace',
          workspace_id: 'mock-workspace-id',
          owner: {
            type: 'user',
            user: { name: 'Notion User' },
          },
        }),
      });
    });

    // ── 2. Navigate to /connectors ───────────────────────────────────────────
    await page.goto('/connectors');

    const notionCard = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Notion (OAuth)', level: 3 }) });
    await expect(notionCard).toBeVisible({ timeout: 10_000 });

    // Disconnect if already connected.
    if (await notionCard.getByRole('button', { name: /disconnect/i }).isVisible()) {
      await notionCard
        .getByRole('button', { name: /disconnect/i })
        .first()
        .click();
      await page
        .getByRole('button', { name: /disconnect/i })
        .last()
        .click();
      await page.waitForTimeout(1_000);
      await page.reload();
      await expect(notionCard).toBeVisible({ timeout: 10_000 });
    }

    // ── 3. Click "Connect with Notion" to open the wizard modal ─────────────
    const connectBtn = notionCard.getByRole('button', { name: /connect with notion/i });
    await connectBtn.click();

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // ── 4. Fill wizard form ───────────────────────────────────────────────────
    await wizard.locator('input[name="clientId"]').fill('notion-test-client-id');
    await wizard.locator('input[name="clientSecret"]').fill('notion-test-client-secret');

    // ── 5. Intercept /start POST ──────────────────────────────────────────────
    let capturedRedirectUri = '';
    let capturedState = '';

    await context.route('**/api/oauth/notion-oauth/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';

      if (location.includes('api.notion.com')) {
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

    // ── 6. Submit ─────────────────────────────────────────────────────────────
    await wizard.getByRole('button', { name: /continue with notion/i }).click();
    await page.waitForTimeout(2_000);

    // ── 7. Navigate to callback with mock code ────────────────────────────────
    expect(capturedRedirectUri).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-notion-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 8. Should land on /connectors ────────────────────────────────────────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 9. Assert connected status ────────────────────────────────────────────
    await expect(
      page
        .locator('.rounded-xl')
        .filter({ has: page.getByRole('heading', { name: 'Notion (OAuth)', level: 3 }) })
        .getByText(/connected/i)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // ── 10. Refresh button must NOT appear (Notion supportsRefresh: false) ────
    const refreshBtn = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Notion (OAuth)', level: 3 }) })
      .getByRole('button', { name: /refresh now/i });
    await expect(refreshBtn).not.toBeVisible();

    await context.unrouteAll();
  });
});
