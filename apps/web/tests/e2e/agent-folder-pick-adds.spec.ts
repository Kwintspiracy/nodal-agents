/**
 * agent-folder-pick-adds.spec.ts — valider Browse… ATTACHE le dossier (#461).
 *
 * Le 24/09, Quentin a choisi un dossier avec Browse… pour son agent Excel,
 * validé la fenêtre, et vu le chemin s'afficher. Rien n'était attaché : il
 * fallait encore cliquer sur « Add ». L'agent a travaillé sans le dossier.
 *
 * Ce que ce parcours prouve, au navigateur : Browse… → « Select this folder »
 * suffit. Le dossier paraît dans la liste, est ENREGISTRÉ pour l'agent, et il
 * n'existe plus de bouton « Add » à oublier.
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect } from '@playwright/test';
import { and, eq, agents, agentWorkspaces } from '@nodal-agents/db';
import { makeDbClient, requireLiveStack, resolveActingUser } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Dossiers d’un agent @cap:travailler-sur-des-fichiers/ecran', () => {
  test('choisir un dossier dans Browse… l’ajoute, sans autre clic', async ({ page }) => {
    const { entityId } = await resolveActingUser();
    const { db, close } = makeDbClient();
    try {
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.entityId, entityId))
        .limit(1);
      test.skip(!agent, 'no agent to attach a folder to');
      const agentId = agent!.id;
      const before = await db
        .select({ id: agentWorkspaces.id })
        .from(agentWorkspaces)
        .where(eq(agentWorkspaces.agentId, agentId));

      await page.goto(`/agents/${agentId}/edit?tab=settings`);
      // Plus de bouton « Add » à oublier.
      await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'Browse…', exact: true }).click();
      // La fenêtre de sélection (ses boutons n'existent qu'en elle).
      await expect(page.getByText('Choose a folder')).toBeVisible();
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      const select = page.getByRole('button', { name: 'Select this folder' });
      await expect(select).toBeEnabled();
      await select.click();

      // Ajouté, et dit.
      await expect(page.getByText('Folder added')).toBeVisible();
      const after = await db
        .select({ id: agentWorkspaces.id, label: agentWorkspaces.label })
        .from(agentWorkspaces)
        .where(eq(agentWorkspaces.agentId, agentId));
      expect(after.length).toBe(before.length + 1);
      const added = after.find((w) => !before.some((b) => b.id === w.id))!;
      // Sans libellé tapé : le nom du dossier.
      expect(added.label.length).toBeGreaterThan(0);
      await expect(page.getByText(added.label, { exact: true }).first()).toBeVisible();

      await db
        .delete(agentWorkspaces)
        .where(and(eq(agentWorkspaces.agentId, agentId), eq(agentWorkspaces.id, added.id)));
    } finally {
      await close();
    }
  });
});
