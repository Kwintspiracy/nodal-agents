// An owner sees the skills an agent learned on its own, and chooses whether it keeps learning.

import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('learned-skills page @cap:apprendre-une-skill/ecran', () => {
  test('renders the Learned Skills page at /learned-skills', async ({ page }) => {
    await page.goto('/learned-skills');
    await expect(page.getByRole('heading', { name: 'Learned Skills', level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    // Toggle should be present
    await expect(page.getByRole('switch', { name: /agent learning/i })).toBeVisible();
  });

  test('toggle switches the reflection_enabled flag (UI responds)', async ({ page }) => {
    await page.goto('/learned-skills');

    const toggle = page.getByRole('switch', { name: /agent learning/i });
    await toggle.waitFor({ state: 'visible' });

    const initialChecked = await toggle.getAttribute('aria-checked');
    await toggle.click();
    // After click the aria-checked should have flipped (optimistic UI)
    await expect(toggle).toHaveAttribute(
      'aria-checked',
      initialChecked === 'true' ? 'false' : 'true',
    );
  });

  test('no window.confirm / window.alert / window.prompt is called (dialog uses ConfirmDialog)', async ({
    page,
  }) => {
    // Wire up dialog detectors BEFORE navigating to the page
    const nativeDialogCalled: string[] = [];
    page.on('dialog', (dialog) => {
      nativeDialogCalled.push(dialog.type());
      void dialog.dismiss();
    });

    await page.goto('/learned-skills');

    // The page should render without any native dialogs during load.
    // Any confirm/archive interactions should use ConfirmDialog (portal modal), not window.confirm.
    expect(nativeDialogCalled).toHaveLength(0);
  });

  test('assignment-mode control renders both options and is interactive', async ({ page }) => {
    await page.goto('/learned-skills');

    // The radiogroup label must be visible
    await expect(page.getByText('When an agent learns a new skill')).toBeVisible({
      timeout: 10_000,
    });

    // Les deux options, par leur ANCRE et non par leur prose : le nom
    // accessible d'une OptionRadio est son libellé SUIVI de sa description, et
    // ce parcours se cassait à la première reformulation (issue #55).
    const autoOption = page.getByTestId('assign-mode-auto');
    const approvalOption = page.getByTestId('assign-mode-approval');
    await expect(autoOption).toBeVisible();
    await expect(approvalOption).toBeVisible();

    // ⚠️ AUCUNE assertion sur l'option cochée AU DÉPART. C'est un réglage de la
    // personne, pas une promesse du produit : sur une installation où il vaut
    // « auto », ce cas rougissait en affirmant « approval » — et il rougissait
    // sur l'installation, pas sur un défaut. Ce qui se prouve ici, c'est que
    // le contrôle EST un choix exclusif et qu'il répond.
    const startedOn = (await approvalOption.getAttribute('aria-checked')) === 'true';
    const [first, second] = startedOn ? [autoOption, approvalOption] : [approvalOption, autoOption];

    // Une seule option cochée à la fois, avant tout geste.
    expect(
      [
        await autoOption.getAttribute('aria-checked'),
        await approvalOption.getAttribute('aria-checked'),
      ].filter((v) => v === 'true'),
      'le groupe doit avoir exactement une option cochée',
    ).toHaveLength(1);

    // Le geste bascule (UI optimiste)…
    await first.click();
    await expect(first).toHaveAttribute('aria-checked', 'true');
    await expect(second).toHaveAttribute('aria-checked', 'false');

    // …et le geste inverse revient à l'état trouvé : ce parcours ne laisse pas
    // derrière lui un réglage qu'il a changé.
    await second.click();
    await expect(second).toHaveAttribute('aria-checked', 'true');
    await expect(first).toHaveAttribute('aria-checked', 'false');
  });
});
