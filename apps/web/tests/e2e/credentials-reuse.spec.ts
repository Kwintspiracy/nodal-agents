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
import {
  requireLiveStack,
  cleanCredentialsByType,
  openConnectorLibrary,
  connectorCard,
  openInstalledConnectors,
  installedConnectorRow,
  removeInstalledConnectorIfPresent,
} from './helpers.ts';

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

    // ── 2. Repartir d'une page propre ──────────────────────────
    for (const label of ['Google Drive', 'Gmail']) {
      await removeInstalledConnectorIfPresent(page, label);
    }

    // ── 3. Connecter Google Drive par l'assistant ──────────────────
    //
    // Le catalogue est derrière l'onglet « Library » et le bouton s'appelle
    // « Install » : la mesure du 11/09 expirait sur l'ancien libellé,
    //
    //   TimeoutError: locator.click: Timeout 10000ms exceeded.
    //   waiting for locator('[data-marketplace-card]').filter({ has:
    //     getByRole('heading', { name: 'Google Drive', level: 3 }) })
    //     .getByRole('button', { name: /connect with google/i })
    //
    // et comme aucun identifiant google-oauth n'existe (beforeAll), la carte
    // ouvre directement le CredentialWizard.
    await openConnectorLibrary(page);
    const driveCard = connectorCard(page, 'Google Drive');
    await expect(driveCard).toBeVisible({ timeout: 10_000 });
    await driveCard.getByRole('button', { name: /^(install|add account)$/i }).click();

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

    // On attend la valeur capturée, pas deux secondes de montre.
    await expect.poll(() => capturedRedirectUri, { timeout: 15_000 }).toBeTruthy();
    expect(capturedState).toBeTruthy();

    // ── 5. Complete Drive callback ────────────────────────────────────────
    const callbackUrl = `${capturedRedirectUri}?code=mock-reuse-code&state=${encodeURIComponent(capturedState)}`;
    await page.goto(callbackUrl);
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });

    // Drive est installé et connecté — c'est une LIGNE du tableau
    // « Installed » depuis la refonte, plus une carte.
    await openInstalledConnectors(page);
    await expect(
      installedConnectorRow(page, 'Google Drive').first().getByText('Connected'),
    ).toBeVisible({ timeout: 10_000 });

    // ── 6. Connecter Gmail avec l'identifiant DÉJÀ créé ──────────────
    //
    // C'est tout l'objet du parcours : un identifiant Google compatible
    // existant, la carte n'ouvre plus l'assistant mais la modale avec le menu
    // « Use existing credential » (ConnectorAddForm, branche oauth2 avec
    // identifiants).
    await openConnectorLibrary(page);
    const gmailCard = connectorCard(page, 'Gmail');
    await expect(gmailCard).toBeVisible({ timeout: 10_000 });
    await gmailCard.getByRole('button', { name: /^(install|add account)$/i }).click();

    const gmailDialog = page.getByRole('dialog');
    const credentialSelect = gmailDialog.locator('select');
    await expect(credentialSelect).toBeVisible({ timeout: 5_000 });

    const credentialNames = await credentialSelect.locator('option').allTextContents();
    expect(
      credentialNames.some(
        (n) => n.includes('My Google (reuse test)') || n.includes('reuse@example.com'),
      ),
    ).toBe(true);

    await gmailDialog.getByRole('button', { name: /^connect$/i }).click();
    await expect(page.getByText('Gmail connected')).toBeVisible({ timeout: 10_000 });

    // ── 7. Les DEUX connecteurs partagent le même identifiant ──────────
    await openInstalledConnectors(page);
    await expect(installedConnectorRow(page, 'Gmail').first().getByText('Connected')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      installedConnectorRow(page, 'Google Drive').first().getByText('Connected'),
    ).toBeVisible();

    // ── Cleanup ───────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
