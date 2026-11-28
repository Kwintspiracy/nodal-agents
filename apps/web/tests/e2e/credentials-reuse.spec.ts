/**
 * An owner reuses one Google credential for a second connector instead of pasting it again.
 *
 * Playwright e2e — Credential reuse across multiple connectors (Brique 34 v3),
 * with the rights each connector needs.
 *
 * Scenario:
 *   1. Create a Google credential via the Google Drive wizard: Google is asked
 *      for Drive's rights (the connector being connected), nothing else
 *   2. The credential appears in the Gmail dropdown, but it holds no Gmail
 *      right: the form says so and offers "Add access" instead of "Connect"
 *   3. "Add access" asks Google for Gmail's rights ON TOP of Drive's, on the
 *      SAME credential (no client id / secret pasted again)
 *   4. Both connectors show CONNECTED with the same credential, which now holds
 *      both connectors' rights
 *
 * No real Google call: the token exchange uses the callback's "mock-" code
 * (opt-in flag of the e2e server), which grants exactly what was asked.
 *
 * Requires a running Nodal-Agents stack. Skipped automatically if unreachable.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  cleanCredentialsByType,
  dropE2ECredentials,
  e2eCredentialName,
  openConnectorLibrary,
  connectorCard,
  openInstalledConnectors,
  installedConnectorRow,
  removeInstalledConnectorIfPresent,
  makeDbClient,
  resolveActingUser,
} from './helpers.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

test.beforeAll(async () => {
  await requireLiveStack();
  // Clean up any credentials from previous runs so the Drive card renders the wizard button
  // and Gmail shows no compatible credentials initially.
  await cleanCredentialsByType('google-oauth');
});

// Les parcours ne doivent pas dépendre de leur ordre : ce qui est créé ici est
// effacé ici, même si le parcours a échoué en route.
test.afterAll(async () => {
  await dropE2ECredentials('google-oauth');
});

test.describe('Credential reuse — Drive + Gmail share one Google credential @cap:connecter-un-service/ecran', () => {
  test('connect Drive via wizard → add Gmail access to the same credential → both connected', async ({
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
    // Le nom PORTE le marqueur e2e : c'est lui qui autorise le nettoyage
    // (`afterAll`) et la garde du parcours suivant à effacer cet identifiant
    // sans jamais toucher au compte d'un humain. Le champ existe toujours dans
    // l'assistant, donc on l'attend au lieu de le remplir « si visible ».
    const nameInput = wizard.locator('input[name="name"]');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(e2eCredentialName('My Google (reuse test)'));

    // ── 4. Intercept /start → capture state ──────────────────────────────
    let capturedRedirectUri = '';
    let capturedState = '';
    let capturedScopes: string[] = [];

    await context.route('**/api/oauth/google-oauth/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';

      if (location.includes('accounts.google.com')) {
        const url = new URL(location);
        capturedRedirectUri = url.searchParams.get('redirect_uri') ?? '';
        capturedState = url.searchParams.get('state') ?? '';
        capturedScopes = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);

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
    // La carte Drive demande les droits de Drive, et pas ceux de Gmail.
    expect(capturedScopes).toContain(DRIVE_SCOPE);
    expect(capturedScopes).not.toContain(GMAIL_READONLY);

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

    // ── 6. Gmail sur l'identifiant DÉJÀ créé : il n'a aucun droit Gmail ────
    //
    // Un identifiant Google compatible existe : la carte ouvre la modale
    // « Use existing credential » (ConnectorAddForm). Mais cet identifiant n'a
    // reçu que les droits de Drive : la modale le dit, et propose « Add access »
    // à la place de « Connect » — le branchement serait refusé.
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

    await expect(gmailDialog.getByText(/has no access to Gmail yet/i)).toBeVisible();
    await expect(gmailDialog.getByText(GMAIL_READONLY)).toBeVisible();
    await expect(gmailDialog.getByRole('button', { name: /^connect$/i })).toHaveCount(0);

    // ── 6b. « Add access » : Gmail EN PLUS de Drive, sur le même identifiant ──
    capturedRedirectUri = '';
    capturedState = '';
    capturedScopes = [];
    await gmailDialog.getByRole('button', { name: /^add access$/i }).click();
    await expect.poll(() => capturedState, { timeout: 15_000 }).toBeTruthy();
    expect(capturedScopes).toContain(GMAIL_READONLY);
    expect(capturedScopes).toContain(DRIVE_SCOPE);

    const addAccessCallback = `${capturedRedirectUri}?code=mock-reuse-add-access&state=${encodeURIComponent(capturedState)}`;
    await page.goto(addAccessCallback);
    await page.waitForURL(/\/connectors/, { timeout: 15_000 });
    await expect(page.getByText('Gmail connected')).toBeVisible({ timeout: 10_000 });

    // ── 7. Les DEUX connecteurs partagent le même identifiant ──────────
    await openInstalledConnectors(page);
    await expect(installedConnectorRow(page, 'Gmail').first().getByText('Connected')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      installedConnectorRow(page, 'Google Drive').first().getByText('Connected'),
    ).toBeVisible();

    // Deux lignes « Connected » ne disent PAS que l'identifiant est partagé :
    // elles diraient la même chose de deux comptes Google distincts, c'est-à-dire
    // du contraire exact de ce que ce parcours porte dans son titre. La seule
    // preuve du partage est en base — un `credential_id`, le même sur les deux
    // connecteurs. C'est le SEUL endroit du parcours qui distingue « réutilisé »
    // de « reconnecté ».
    const { entityId } = await resolveActingUser();
    const { connectors, credentials, eq, and, inArray } = await import('@nodal-agents/db');
    const { db, close } = makeDbClient();
    try {
      const rows = await db
        .select({ slug: connectors.slug, credentialId: connectors.credentialId })
        .from(connectors)
        .where(
          and(
            eq(connectors.entityId, entityId),
            inArray(connectors.slug, ['google-drive', 'gmail']),
          ),
        );
      const drive = rows.find((r) => r.slug === 'google-drive');
      const gmail = rows.find((r) => r.slug === 'gmail');
      expect(drive?.credentialId, 'Google Drive sans identifiant en base').toBeTruthy();
      expect(gmail?.credentialId, 'Gmail sans identifiant en base').toBeTruthy();
      expect(gmail!.credentialId).toBe(drive!.credentialId);

      // Et cet identifiant unique est bien celui que l'assistant a créé, qui
      // porte maintenant les droits des DEUX connecteurs.
      const [cred] = await db
        .select({ type: credentials.type })
        .from(credentials)
        .where(eq(credentials.id, drive!.credentialId!));
      expect(cred?.type).toBe('google-oauth');
      const { decryptCredentialForDisplay } = await import('@nodal-agents/db');
      const decrypted = await decryptCredentialForDisplay(db, drive!.credentialId!);
      const granted = decrypted!.payload.scopes.split(' ');
      expect(granted).toContain(DRIVE_SCOPE);
      expect(granted).toContain(GMAIL_READONLY);
    } finally {
      await close();
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    await context.unrouteAll();
  });
});
