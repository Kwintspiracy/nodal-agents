// An owner sees the skills an agent learned on its own, and chooses whether it keeps learning.

import { test, expect } from '@playwright/test';
import { makeDbClient, pollDb, requireLiveStack, resolveActingUser } from './helpers.ts';

/** L'espace au nom duquel le dashboard agit : c'est SA ligne qui porte le réglage. */
let entityId: string;

test.beforeAll(async () => {
  await requireLiveStack();
  ({ entityId } = await resolveActingUser());
});

/**
 * Le mode d'affectation ENREGISTRÉ, attendu jusqu'à ce qu'il vaille `expected`.
 *
 * L'écran bascule de façon optimiste : il montre le nouveau choix avant que le
 * serveur ne l'ait écrit. Recharger la page juste après le clic court donc
 * après l'écriture et lit l'ancienne valeur — c'est ce qui a fait rougir ce cas
 * au rejeu de la PR #293. La base est la seule chose qui dise si le réglage a
 * vraiment changé.
 */
async function assignmentModeBecomes(expected: 'auto' | 'approval'): Promise<void> {
  const { entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await pollDb(
      async () => {
        const [row] = await db
          .select({ mode: entities.skillAssignmentMode })
          .from(entities)
          .where(eq(entities.id, entityId))
          .limit(1);
        return row?.mode === expected ? row.mode : null;
      },
      { timeoutMs: 15_000, intervalMs: 250 },
    );
  } finally {
    await close();
  }
}

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

    // Les deux options, par leur RÔLE **et** par leur ANCRE.
    //
    // Le rôle, parce que c'est la promesse d'accessibilité du contrôle : un
    // `<div>` qui perdrait son `role="radio"` doit faire rougir ce parcours.
    // L'ancre, parce que le nom accessible d'une `OptionRadio` est sa PROSE —
    // son libellé suivi de sa description — et que désigner l'option par ce
    // texte casse à la première reformulation (issue #55). `and()` exige les
    // deux à la fois : c'est bien un radio, et c'est bien celui-là.
    const autoOption = page.getByRole('radio').and(page.getByTestId('assign-mode-auto'));
    const approvalOption = page.getByRole('radio').and(page.getByTestId('assign-mode-approval'));
    await expect(autoOption).toBeVisible();
    await expect(approvalOption).toBeVisible();

    // L'ÉTAT DE DÉPART EST UNE PROMESSE DU PRODUIT : une installation neuve
    // attend l'accord de la personne avant d'affecter une skill apprise. C'est
    // le défaut sûr, et il se vérifie ici — sans quoi le changer passerait sans
    // que rien ne rougisse (revue de la PR #293, constat bloquant).
    //
    // La base de ce parcours est neuve par construction, donc le défaut y
    // tient. Sur une installation VIVANTE réglée sur « auto », ce cas rougit :
    // c'est alors l'installation qu'il décrit, pas un défaut du produit.
    await expect(
      approvalOption,
      'une installation neuve doit demander l’accord avant d’affecter une skill apprise',
    ).toHaveAttribute('aria-checked', 'true');
    await expect(autoOption).toHaveAttribute('aria-checked', 'false');

    // Une seule option cochée à la fois : le groupe est un choix EXCLUSIF.
    expect(
      [
        await autoOption.getAttribute('aria-checked'),
        await approvalOption.getAttribute('aria-checked'),
      ].filter((v) => v === 'true'),
      'le groupe doit avoir exactement une option cochée',
    ).toHaveLength(1);

    // Le geste bascule (UI optimiste)…
    await autoOption.click();
    await expect(autoOption).toHaveAttribute('aria-checked', 'true');
    await expect(approvalOption).toHaveAttribute('aria-checked', 'false');

    // …et il est ENREGISTRÉ. L'écran bascule de façon optimiste, donc l'état à
    // l'écran ne dit rien de ce qui a été écrit : la base le dit. Ce cas
    // n'avait jusqu'ici aucune preuve d'enregistrement, et l'attendre est
    // aussi ce qui rend le geste suivant possible — une action serveur
    // appelée du client est une transition React, et React LIE les transitions
    // en cours, si bien que deux clics enchaînés n'écrivaient que le premier.
    // Ce parcours affirmait rendre le réglage à la personne et la laissait sur
    // « auto » (constaté en base au rejeu de la PR #293).
    await assignmentModeBecomes('auto');

    // Le geste inverse, et la même preuve : le réglage est RENDU tel qu'il
    // était. Un parcours ne laisse pas derrière lui un choix qu'il a changé.
    await approvalOption.click();
    await expect(approvalOption).toHaveAttribute('aria-checked', 'true');
    await expect(autoOption).toHaveAttribute('aria-checked', 'false');
    await assignmentModeBecomes('approval');
  });
});
