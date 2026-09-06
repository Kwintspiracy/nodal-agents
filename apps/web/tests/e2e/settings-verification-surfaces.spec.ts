/**
 * Vérifier & Corriger, T23 — la section « Verification surfaces » de /settings.
 *
 *  - décocher une surface ouvre le ConfirmDialog ; annuler laisse la case cochée ;
 *  - recocher n'ouvre AUCUN dialogue (l'asymétrie voulue, inverse du frein) ;
 *  - la pilule « owner only » est là.
 *
 * La stack (web + runner + DB) doit tourner. En local-trust la session est le
 * propriétaire : le cas « non-owner ⇒ cases désactivées » se prouve dans le test
 * unitaire de l'action (isOwner false) et par le composant (disabled) — une
 * seconde identité n'est pas fabricable ici sans compte.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

function surfacesSection(page: Page): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Verification surfaces', level: 2 }) })
    .first();
}

test.describe('Verification surfaces — /settings', () => {
  test('la section rend ses quatre cases et la pilule owner only', async ({ page }) => {
    await page.goto('/settings');
    const section = surfacesSection(page);
    await expect(section).toBeVisible();
    await expect(section.getByText('owner only')).toBeVisible();
    for (const key of ['codeTask', 'cliRuntime', 'fileOps', 'shell']) {
      await expect(section.getByTestId(`verification-surface-${key}`)).toBeVisible();
    }
  });

  test('décocher demande confirmation, annuler laisse la case cochée', async ({ page }) => {
    await page.goto('/settings');
    const section = surfacesSection(page);
    const shell = section.getByTestId('verification-surface-shell');
    test.skip(!(await shell.isChecked()), 'shell déjà décochée : pas de décochage à tester');

    await shell.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Stop verifying')).toBeVisible();
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
    await expect(shell).toBeChecked();
  });

  test('décocher puis recocher : le second geste n’ouvre aucun dialogue', async ({ page }) => {
    await page.goto('/settings');
    const section = surfacesSection(page);
    const shell = section.getByTestId('verification-surface-shell');
    test.skip(!(await shell.isChecked()), 'shell déjà décochée : état non nominal');

    await shell.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stop verifying' }).click();
    await expect(dialog).toBeHidden();
    await expect(shell).not.toBeChecked();

    // Recocher : aucun dialogue, la case revient à cochée.
    await shell.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(shell).toBeChecked();
  });
});
