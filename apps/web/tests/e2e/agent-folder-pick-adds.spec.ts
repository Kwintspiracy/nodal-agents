/**
 * agent-folder-pick-adds.spec.ts — valider Browse… ATTACHE le dossier (#461).
 *
 * Le 24/09, Quentin a choisi un dossier avec Browse… pour son agent Excel,
 * validé la fenêtre, et vu le chemin s'afficher. Rien n'était attaché : il
 * fallait encore cliquer sur « Add ». L'agent a travaillé sans le dossier.
 *
 * Ce que ce parcours prouve, au navigateur et dans la base :
 *  - Browse… → « Select this folder » suffit : la ligne enregistrée porte LE
 *    chemin choisi, et pour libellé le nom de ce dossier ;
 *  - choisir un dossier dont le libellé est déjà pris le DIT, met ce libellé
 *    dans le champ, et Browse… rouvre sur le même dossier : corriger le libellé
 *    et revalider l'attache (revue de la PR #467).
 *
 * L'agent est créé pour le parcours et supprimé après (ses dossiers partent
 * avec lui) : un libellé resté d'un autre essai ne peut pas le faire rougir.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect } from '@playwright/test';
import { eq, agents, agentWorkspaces } from '@nodal-agents/db';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

let agentId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Folder Pick ${testSlugSuffix()}`,
        slug: `e2e-folder-pick-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { db, close } = makeDbClient();
  try {
    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

async function foldersOfAgent() {
  const { db, close } = makeDbClient();
  try {
    const rows = await db
      .select({ label: agentWorkspaces.label, path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.agentId, agentId));
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  } finally {
    await close();
  }
}

test.describe('Dossiers d’un agent @cap:travailler-sur-des-fichiers/ecran', () => {
  test('choisir un dossier dans Browse… l’ajoute ; un libellé pris se dit et se corrige', async ({
    page,
  }) => {
    await page.goto(`/agents/${agentId}/edit?tab=settings`);
    // Plus de bouton « Add » à oublier.
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);

    // 1. Browse… → Home → Select : attaché, sous le nom du dossier.
    await page.getByRole('button', { name: 'Browse…', exact: true }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByText('Choose a folder')).toBeVisible();
    await picker.getByRole('button', { name: 'Home', exact: true }).click();
    const shownPath = picker.locator('code').first();
    await expect(shownPath).not.toHaveText('Drives');
    const home = (await shownPath.textContent())!.trim();
    const homeName = home.split(/[/\\]/).filter(Boolean).pop()!;
    await picker.getByRole('button', { name: 'Select this folder' }).click();

    // Exact : « Folder added, but the list could not be reloaded » n'est pas un succès.
    await expect(page.getByText('Folder added', { exact: true })).toBeVisible();
    expect(await foldersOfAgent()).toEqual([{ label: homeName, path: home }]);

    // 2. Le même dossier, sans libellé : le libellé est pris. Refusé, et dit.
    await page.getByRole('button', { name: 'Browse…', exact: true }).click();
    await picker.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(shownPath).toHaveText(home);
    await picker.getByRole('button', { name: 'Select this folder' }).click();
    await expect(
      page.getByText(
        `This agent already has a folder labelled “${homeName}”. Change the label, then Browse… again.`,
      ),
    ).toBeVisible();
    const labelField = page.getByPlaceholder('Label (optional)');
    await expect(labelField).toHaveValue(homeName);

    // 3. Corriger le libellé ; Browse… rouvre sur le même dossier, sans Home.
    await labelField.fill('e2e-second');
    await page.getByRole('button', { name: 'Browse…', exact: true }).click();
    await expect(shownPath).toHaveText(home);
    await picker.getByRole('button', { name: 'Select this folder' }).click();
    await expect.poll(foldersOfAgent).toEqual(
      [
        { label: homeName, path: home },
        { label: 'e2e-second', path: home },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    );
  });
});
