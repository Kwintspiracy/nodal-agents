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
  await cleanCredentialsByType('notion-oauth');
});

test.describe('Notion OAuth flow (wizard-driven) @cap:connecter-un-service', () => {
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

    // Le catalogue vit derrière l'onglet « Library » : la page ouvre sur
    // « Installed », où aucune carte de catalogue n'existe. Le parcours
    // cliquait « Connect with Notion » sur une carte invisible, et la mesure
    // du 11/09 expirait dessus :
    //
    //   TimeoutError: locator.click: Timeout 10000ms exceeded.
    //   waiting for locator('[data-marketplace-card]').filter({ has:
    //     getByRole('heading', { name: 'Notion (OAuth)', level: 3 }) })
    //     .getByRole('button', { name: /connect with notion/i })
    //
    // `beforeAll` ayant supprimé les identifiants notion-oauth, la carte ouvre
    // DIRECTEMENT le CredentialWizard (`needsWizard`).
    await openConnectorLibrary(page);
    const notionCard = connectorCard(page, 'Notion (OAuth)');
    await expect(notionCard).toBeVisible({ timeout: 10_000 });
    await notionCard.getByRole('button', { name: /^(install|add account)$/i }).click();

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

    // ── 7. Navigate to callback with mock code ────────────────────────────────
    // On attend la valeur capturée, pas deux secondes de montre.
    await expect.poll(() => capturedRedirectUri, { timeout: 15_000 }).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-notion-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 8. Should land on /connectors ────────────────────────────────────────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 9. L'instance installée dit « Connected » ──────────────────
    await openInstalledConnectors(page);
    const row = installedConnectorRow(page, 'Notion (OAuth)').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Connected')).toBeVisible({ timeout: 10_000 });

    // ── 10. Aucun bouton de rafraîchissement (Notion : supportsRefresh false)
    //
    // L'absence se vérifie LÀ OÙ le bouton vivrait : dans la modale d'édition
    // de l'instance (ConnectorForm), pas sur la ligne du tableau — où aucun
    // connecteur n'en a jamais, donc où l'assertion serait vraie sans rien
    // prouver. « Reconnect » sert de témoin : la modale est bien à l'écran.
    await row.getByRole('button', { name: 'Edit' }).click();
    const editModal = page.getByRole('dialog');
    await expect(editModal.getByRole('button', { name: /^reconnect$/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(editModal.getByRole('button', { name: /refresh now/i })).toHaveCount(0);

    await context.unrouteAll();
  });
});
