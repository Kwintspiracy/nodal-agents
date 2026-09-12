/**
 * Playwright e2e — régression du connecteur Notion « Internal Integration »
 * (chemin api_key).
 *
 * Prouve que le chemin api_key d'origine marche toujours depuis que la brique
 * 34 a ajouté `notion-oauth` : les deux coexistent, indépendamment.
 *
 * ⚠️ Le parcours cherchait la carte sur la page d'accueil de /connectors et un
 * bouton « Connect » dessus. Depuis la refonte le catalogue est derrière
 * l'onglet « Library », le bouton s'appelle « Install » (ou « Add account »), et
 * le formulaire s'ouvre dans une modale — pas dans la carte. Message de la
 * mesure du 11/09 :
 *
 *   TimeoutError: locator.click: Timeout 10000ms exceeded.
 *   waiting for locator('[data-marketplace-card]').filter({ has:
 *     getByRole('heading', { name: 'Notion', exact: true, level: 3 }) })
 *     .getByRole('button', { name: /^connect$/i })
 *
 * Le `waitForTimeout(1000)` qui tenait lieu d'attente après déconnexion est
 * parti avec : `removeInstalledConnectorIfPresent` attend le toast.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  openConnectorInstallDialog,
  openInstalledConnectors,
  installedConnectorRow,
  removeInstalledConnectorIfPresent,
} from './helpers.ts';

const INSTANCE_NAME = 'Notion — e2e internal';
const TEST_API_KEY = 'secret_test_internal_integration_key_e2e'; // secrets:allow (fake placeholder)

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Notion Internal Integration (api_key) — regression', () => {
  test('connect with api_key shows connected status and persists', async ({ page }) => {
    // ── 0. On part d'une page propre ────────────────────────────────────────
    await removeInstalledConnectorIfPresent(page, INSTANCE_NAME);

    // ── 1-2. La carte « Notion » (PAS « Notion (OAuth) ») et son formulaire ─
    await openConnectorInstallDialog(page, 'Notion');
    const dialog = page.getByRole('dialog');
    // Un connecteur api_key montre ses deux champs d'emblée — c'est ce qui le
    // distingue du chemin OAuth, qui passerait par le CredentialWizard.
    await expect(dialog.locator('input[name="name"]')).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator('input[name="apiKey"]')).toBeVisible({ timeout: 5_000 });

    // ── 3-4. Nom + clé, puis valider ────────────────────────────────────────
    await dialog.locator('input[name="name"]').fill(INSTANCE_NAME);
    await dialog.locator('input[name="apiKey"]').fill(TEST_API_KEY);
    await dialog.getByRole('button', { name: /^connect$/i }).click();

    // ── 5. Le toast ─────────────────────────────────────────────────────────
    await expect(page.getByText(`${INSTANCE_NAME} connected`)).toBeVisible({ timeout: 10_000 });

    // ── 6. La ligne installée dit « Connected », et elle survit au rechargement
    await openInstalledConnectors(page);
    const row = installedConnectorRow(page, INSTANCE_NAME).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Connected')).toBeVisible();
    // `api_key` apparaît deux fois sur la ligne (type d'auth sous le nom du
    // fournisseur, et colonne Scopes qui n'a pas de scope à montrer).
    await expect(row.getByText('api_key', { exact: true }).first()).toBeVisible();

    // ── 7. Aucun contrôle propre à OAuth sur une instance api_key ───────────
    await expect(row.getByRole('button', { name: /refresh now/i })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /reconnect/i })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^disconnect$/i })).toHaveCount(0);

    // ── 8. Ménage ───────────────────────────────────────────────────────────
    await removeInstalledConnectorIfPresent(page, INSTANCE_NAME);
  });
});
