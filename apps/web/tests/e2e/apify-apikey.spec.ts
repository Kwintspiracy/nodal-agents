/**
 * Playwright e2e — connecteur Apify (auth api_key), parcours complet.
 *
 * Ce que le parcours prouve :
 *  1. La carte Apify est dans le catalogue (onglet « Library »).
 *  2. « Install » ouvre une modale avec les champs name + apiKey visibles
 *     d'emblée — pas d'étape d'ouverture secondaire.
 *  3. Valider crée une instance, qui apparaît dans « Installed ».
 *  4. L'instance se supprime par le bouton de ligne + ConfirmDialog.
 *
 * ⚠️ Il visait l'ancienne page : une `<section>` « Marketplace » de niveau 2 et
 * une `<section>` « Active Connectors ». Aucune des deux n'existe depuis la
 * refonte, et l'erreur de la mesure nocturne le disait mot pour mot :
 *
 *   expect(locator).toBeVisible() failed
 *   Locator: locator('section').filter({ has: getByRole('heading',
 *     { name: 'Marketplace', level: 2 }) })
 *   Error: element(s) not found
 *
 * Les trois gestes de la page vivent maintenant dans `helpers.ts`.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  openConnectorInstallDialog,
  openInstalledConnectors,
  installedConnectorRow,
  removeInstalledConnectorIfPresent,
} from './helpers.ts';

const CONNECTOR_LABEL = 'Apify';
const INSTANCE_NAME = 'Apify — e2e smoke';
const TEST_API_KEY = 'apify_api_e2e_test_key_12345678';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

test.describe('Apify api_key connector smoke test', () => {
  test('marketplace card opens modal; connect with name + apiKey creates active instance', async ({
    page,
  }) => {
    // ── 0. Reste d'une course précédente ────────────────────────────────────
    await removeInstalledConnectorIfPresent(page, INSTANCE_NAME);

    // ── 1-2. La carte du catalogue, puis « Install » ────────────────────────
    await openConnectorInstallDialog(page, CONNECTOR_LABEL);

    const dialog = page.getByRole('dialog');
    const nameInput = dialog.locator('input[name="name"]');
    const apiKeyInput = dialog.locator('input[name="apiKey"]');

    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });

    // ── 3. Nom + clé ────────────────────────────────────────────────────────
    await nameInput.fill(INSTANCE_NAME);
    await apiKeyInput.fill(TEST_API_KEY);

    // ── 4. Valider ──────────────────────────────────────────────────────────
    await dialog.getByRole('button', { name: /^connect$/i }).click();

    // ── 5. Le toast de ConnectorAddForm ─────────────────────────────────────
    await expect(page.getByText(`${INSTANCE_NAME} connected`)).toBeVisible({ timeout: 10_000 });
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // ── 6. L'instance est dans « Installed », et elle est connectée ─────────
    await openInstalledConnectors(page);
    const row = installedConnectorRow(page, INSTANCE_NAME).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Connected')).toBeVisible();

    // ── 7. Ménage, par les vrais gestes ─────────────────────────────────────
    await row.getByRole('button', { name: /^delete$/i }).click();
    const confirm = page.getByRole('dialog');
    await confirm.waitFor({ state: 'visible', timeout: 5_000 });
    await confirm.getByRole('button', { name: /^delete$/i }).click();
    await expect(page.getByText(`${INSTANCE_NAME} removed`)).toBeVisible({ timeout: 10_000 });
  });
});
