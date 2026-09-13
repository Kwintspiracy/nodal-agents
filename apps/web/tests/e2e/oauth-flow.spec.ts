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
  await cleanCredentialsByType('google-oauth');
});

test.describe('Google Drive OAuth flow (wizard-driven) @cap:connecter-un-service', () => {
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

    // ── 3. Le catalogue, derrière l'onglet « Library » ───────────────
    //
    // La page ouvre sur « Installed », où aucune carte de catalogue n'existe.
    // Le parcours cliquait « Connect with Google » sur une carte qu'il ne
    // pouvait pas voir, et la mesure du 11/09 expirait dessus :
    //
    //   TimeoutError: locator.click: Timeout 10000ms exceeded.
    //   waiting for locator('[data-marketplace-card]').filter({ has:
    //     getByRole('heading', { name: 'Google Drive', level: 3 }) })
    //     .getByRole('button', { name: /connect with google/i })
    //
    // Le bouton s'appelle désormais « Install », et comme `beforeAll` a
    // supprimé les identifiants Google, la carte ouvre DIRECTEMENT le
    // CredentialWizard (ConnectorsMarketplaceGrid, `needsWizard`).
    await openConnectorLibrary(page);
    const driveCard = connectorCard(page, 'Google Drive');
    await expect(driveCard).toBeVisible({ timeout: 10_000 });

    // ── 4. Ouvrir l'assistant ───────────────────────────────────
    await driveCard.getByRole('button', { name: /^(install|add account)$/i }).click();

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

    // ── 8. L'aller-retour /start intercepté ──────────────────────────────────
    // On attend la VALEUR, pas deux secondes : une pause fixe est verte ou
    // rouge selon la charge de la machine, jamais selon le produit.
    await expect.poll(() => capturedRedirectUri, { timeout: 15_000 }).toBeTruthy();
    expect(capturedState).toBeTruthy();

    const callbackUrl = `${capturedRedirectUri}?code=mock-google-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);

    // ── 9. Should land back on /connectors (via auto-assignment redirect) ────
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // ── 10. Le connecteur est installé et connecté ──────────────────
    // Ce n'est plus une carte qui porte l'état mais une LIGNE de l'onglet
    // « Installed » (ConnectorsInstalledTable).
    await openInstalledConnectors(page);
    const row = installedConnectorRow(page, 'Google Drive').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Connected')).toBeVisible({ timeout: 10_000 });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
