/**
 * connector-multi-instance.spec.ts — régression de la brique multi-instances.
 *
 * Garde que la contrainte UNIQUE(entity_id, slug) a bien été levée sur
 * `connectors` et que l'UI laisse créer DEUX instances du même connecteur
 * api_key. Connecteur d'essai : `tavily` (api_key, aucun appel externe).
 *
 * Le parcours :
 *  1. Catalogue → « Install » sur Tavily → nom + clé → Connect.
 *  2. Catalogue à nouveau : la carte porte désormais « Add account », preuve
 *     que le catalogue ne retire pas un connecteur déjà installé.
 *  3. Deuxième instance, autre nom, autre clé.
 *  4. Les DEUX apparaissent dans « Installed ».
 *  5. Ménage : les deux se suppriment, et ne reviennent pas.
 *
 * ⚠️ Il visait l'ancienne page (`<section>` « Marketplace » / « Active
 * Connectors », bouton « + Add », formulaire DANS la carte). La mesure du
 * 11/09 le disait mot pour mot :
 *
 *   expect(locator).toBeVisible() failed
 *   Locator: locator('section').filter({ has: getByRole('heading',
 *     { name: 'Marketplace', level: 2 }) })
 *   Error: element(s) not found
 *
 * Les trois `waitForTimeout(300)` qui rattrapaient les rafraîchissements ont
 * disparu avec : on attend le toast, qui est le VRAI signal.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  openConnectorInstallDialog,
  openInstalledConnectors,
  installedConnectorRow,
  removeInstalledConnectorIfPresent,
  connectorCard,
  openConnectorLibrary,
} from './helpers.ts';

const CONNECTOR_LABEL = 'Tavily';
const INSTANCE_A = 'Tavily — perso';
const INSTANCE_B = 'Tavily — boulot';
const API_KEY_A = 'test-tavily-key-perso-1234';
const API_KEY_B = 'test-tavily-key-boulot-5678';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

/** Remplit la modale d'installation api_key et valide. */
async function connectApiKeyInstance(
  page: import('@playwright/test').Page,
  name: string,
  apiKey: string,
): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[name="name"]')).toBeVisible({ timeout: 5_000 });
  await dialog.locator('input[name="name"]').fill(name);
  await dialog.locator('input[name="apiKey"]').fill(apiKey);
  await dialog.getByRole('button', { name: /^connect$/i }).click();
  await expect(page.getByText(`${name} connected`)).toBeVisible({ timeout: 10_000 });
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

test.describe('Connector multi-instance', () => {
  test('can create two instances of the same api_key connector and both appear in Active Connectors', async ({
    page,
  }) => {
    // ── 0. Restes d'une course précédente ───────────────────────────────────
    await removeInstalledConnectorIfPresent(page, INSTANCE_A);
    await removeInstalledConnectorIfPresent(page, INSTANCE_B);

    // ── 1. Première instance ────────────────────────────────────────────────
    await openConnectorInstallDialog(page, CONNECTOR_LABEL);
    await connectApiKeyInstance(page, INSTANCE_A, API_KEY_A);

    // ── 2. La carte reste au catalogue, avec « Add account » ────────────────
    await openConnectorLibrary(page);
    const card = connectorCard(page, CONNECTOR_LABEL);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole('button', { name: /^add account$/i })).toBeVisible();

    // ── 3. Deuxième instance ────────────────────────────────────────────────
    await card.getByRole('button', { name: /^add account$/i }).click();
    await connectApiKeyInstance(page, INSTANCE_B, API_KEY_B);

    // ── 4. Les deux sont installées ─────────────────────────────────────────
    await openInstalledConnectors(page);
    await expect(installedConnectorRow(page, INSTANCE_A).first()).toBeVisible({ timeout: 10_000 });
    await expect(installedConnectorRow(page, INSTANCE_B).first()).toBeVisible({ timeout: 10_000 });

    // ── 5. Ménage, puis vérification qu'elles ne reviennent pas ─────────────
    await removeInstalledConnectorIfPresent(page, INSTANCE_A);
    await removeInstalledConnectorIfPresent(page, INSTANCE_B);

    await openInstalledConnectors(page);
    await expect(installedConnectorRow(page, INSTANCE_A)).toHaveCount(0);
    await expect(installedConnectorRow(page, INSTANCE_B)).toHaveCount(0);
  });
});
