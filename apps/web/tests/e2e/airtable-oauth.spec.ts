/**
 * Playwright e2e — Airtable OAuth flow (Brique 34 v3).
 *
 * Airtable uses PKCE S256 + Basic auth on the token endpoint.
 * Flow mirrors Google Drive but uses the airtable-oauth-specific paths.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  cleanCredentialsByType,
  openConnectorLibrary,
  connectorCard,
  openInstalledConnectors,
  installedConnectorRow,
} from './helpers.ts';

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

    // ── 3-4. Le catalogue, derrière l'onglet « Library » ─────────────
    //
    // La page ouvre sur « Installed », où aucune carte de catalogue n'existe,
    // et le bouton ne s'appelle plus « Connect with Airtable ». La mesure du
    // 11/09 expirait exactement là :
    //
    //   TimeoutError: locator.click: Timeout 10000ms exceeded.
    //   waiting for locator('[data-marketplace-card]').filter({ has:
    //     getByRole('heading', { name: 'Airtable (OAuth)', level: 3 }) })
    //     .getByRole('button', { name: /connect with airtable/i })
    await openConnectorLibrary(page);
    const airtableCard = connectorCard(page, 'Airtable (OAuth)');
    await expect(airtableCard).toBeVisible({ timeout: 10_000 });
    await airtableCard.getByRole('button', { name: /^(install|add account)$/i }).click();

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

    // On attend la valeur capturée, pas deux secondes de montre.
    await expect.poll(() => capturedRedirectUri, { timeout: 15_000 }).toBeTruthy();

    // ── 8. Navigate to callback with mock code ────────────────────────────────
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-airtable-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 9. Should land on /connectors ────────────────────────────────────────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 10. L'instance installée dit « Connected » ─────────────────
    await openInstalledConnectors(page);
    const row = installedConnectorRow(page, 'Airtable (OAuth)').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Connected')).toBeVisible({ timeout: 10_000 });

    // Airtable sait rafraîchir son jeton : le bouton vit dans la modale
    // d'édition de l'instance (ConnectorForm), pas sur la ligne du tableau.
    await row.getByRole('button', { name: 'Edit' }).click();
    const editModal = page.getByRole('dialog');
    await expect(editModal.getByRole('button', { name: /refresh now/i })).toBeVisible({
      timeout: 10_000,
    });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
