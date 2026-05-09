/**
 * Playwright e2e — OAuth flow for Notion (OAuth / Public Integration).
 *
 * Similar to oauth-flow.spec.ts but for the Notion OAuth provider which:
 * - Does not use PKCE
 * - Uses Basic auth on the token endpoint
 * - Returns workspace info in the token response (no separate userinfo endpoint)
 * - Does not have a Refresh button (supportsRefresh: false)
 *
 * Requires a running NodalAI stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Notion OAuth flow', () => {
  test('connect → callback → connected status (no Refresh button)', async ({ page, context }) => {
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

    // Find the Notion (OAuth) card using the rounded-xl container class.
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
    }

    // ── 3. Open the connect form ──────────────────────────────────────────────
    await notionCard.getByRole('button', { name: /^connect$/i }).click();
    await expect(notionCard.locator('input[name="clientId"]')).toBeVisible({ timeout: 5_000 });

    // ── 4. Fill credentials ───────────────────────────────────────────────────
    await notionCard.locator('input[name="clientId"]').fill('notion-test-client-id');
    await notionCard.locator('input[name="clientSecret"]').fill('notion-test-client-secret');

    // ── 5. Intercept the /start POST: forward to server, capture Location header,
    //       then stop the browser from navigating to api.notion.com.
    let capturedRedirectUri = '';
    let capturedState = '';

    await context.route('**/api/oauth/notion-oauth/start', async (route) => {
      // Forward without following redirects to capture the Location header.
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
    await notionCard.getByRole('button', { name: /continue with notion \(oauth\)/i }).click();
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

    // ── 10. Refresh button must NOT be present for Notion OAuth ───────────────
    const refreshBtn = page
      .locator('.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Notion (OAuth)', level: 3 }) })
      .getByRole('button', { name: /refresh now/i });
    await expect(refreshBtn).not.toBeVisible();

    await context.unrouteAll();
  });
});
