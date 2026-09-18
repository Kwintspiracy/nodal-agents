/**
 * Playwright e2e — CONNECTOR-001: how far a connector's token reaches is stated
 * BEFORE the provider's consent screen.
 *
 * Four Google connectors request the broadest scope in their family because
 * their tools genuinely need it: `drive.file` cannot open a file the user
 * already has, and the `.readonly` variants cannot write. That scope is
 * defensible. Letting "connect Google Drive" read as "the files it needs" is
 * not — so the product says the reach out loud, in its own words, while the
 * user can still walk away.
 *
 * Unit tests already pin the data (packages/shared oauth-scopes.test.ts fails if
 * a blanket scope carries no disclosure). What they cannot show is whether the
 * sentence ever reaches a screen. That is this file's whole job.
 *
 * Written after `oauth-flow.spec.ts` was found chasing `.rounded-xl` on a card
 * that renders `rounded-2xl` — one character, and the suite had been reporting a
 * missing Google Drive card ever since the connectors redesign. Selectors here
 * are anchored on ROLES and ANCHORS, never on utility classes.
 *
 * ## CE QUE L'ISSUE #72 A APPRIS À CE FICHIER
 *
 * Ces cas ont été verts sur la machine du propriétaire le 10/09 et rouges sur
 * un runner GitHub le 11/09, sans qu'une ligne de code ait changé entre les
 * deux. La raison n'était ni une régression ni un service manquant : le bouton
 * « Install » ouvre DEUX modales différentes selon l'installation. Là où un
 * identifiant Google existe déjà, c'est `ConnectorAddForm` ; sur une
 * installation neuve, `needsWizard` est vrai et c'est le `CredentialWizard` —
 * qui ne rendait alors AUCUNE divulgation. Le vert du 10/09 était donc le vert
 * du mauvais chemin, et le rouge disait la vérité : on ne pouvait pas lire
 * jusqu'où va le jeton la première fois qu'on connecte Google, le seul moment
 * où l'avertissement sert. Défaut produit #83, corrigé depuis.
 *
 * Ce fichier ne se contente donc plus de trouver « un dialogue » : il DIT
 * lequel il a devant lui, et il exige la divulgation sur les deux chemins. Un
 * parcours qui ne sait pas quel branchement il éprouve peut être vert pour la
 * mauvaise raison, et personne ne le saura.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  requireLiveStack,
  openConnectorInstallDialog,
  type ConnectorDialogKind,
} from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe.configure({ timeout: 60_000 });

/**
 * Ferme la modale ouverte, quel que soit son chemin : les deux portent un
 * bouton « Cancel ». Le geste est le même, seul le dialogue diffère.
 */
async function closeDialog(page: Page): Promise<void> {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^cancel$/i })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
}

/** La divulgation, exigée en NOMMANT le chemin sur lequel elle manque. */
async function expectDisclosure(
  page: Page,
  opened: ConnectorDialogKind,
  label: string,
): Promise<void> {
  const path = opened === 'wizard' ? 'première connexion (assistant)' : 'compte existant';
  await expect(
    page.getByRole('dialog').getByText(/what this connector can reach/i),
    `${label} : aucune divulgation sur le chemin « ${path} ». C'est le défaut de l'issue #83 : ` +
      'la portée du jeton doit se lire sur les DEUX chemins, et surtout sur le premier, qui ' +
      'est le seul où la personne peut encore renoncer.',
  ).toBeVisible({ timeout: 10_000 });
}

test.describe('Connector scope disclosure @cap:connecter-un-service/ecran', () => {
  test('Google Drive states it reaches the ENTIRE Drive', async ({ page }) => {
    const opened = await openConnectorInstallDialog(page, 'Google Drive');
    // Le chemin est DIT, pas supposé : il paraîtra dans le rapport le jour où
    // ce cas rougira, et c'est exactement ce qui manquait les 10 et 11/09.
    console.log(`[scope] Google Drive ouvre : ${opened}`);

    await expectDisclosure(page, opened, 'Google Drive');
    // The specific claim, not just the heading: an owner must read that this is
    // every file, not only the ones agents create.
    await expect(page.getByRole('dialog').getByText(/entire google drive/i)).toBeVisible();
  });

  test('Google Sheets and Docs disclose their reach too', async ({ page }) => {
    for (const label of ['Google Sheets', 'Google Docs']) {
      const opened = await openConnectorInstallDialog(page, label);
      console.log(`[scope] ${label} ouvre : ${opened}`);
      await expectDisclosure(page, opened, label);
      await closeDialog(page);
    }
  });

  test('a connector whose reach matches its name shows NO disclosure', async ({ page }) => {
    // Gmail asks only for readonly + send, which is what "connect Gmail" already
    // implies. A banner there would be noise, and noise is what teaches people
    // to skip the banner that matters.
    const opened = await openConnectorInstallDialog(page, 'Gmail');
    console.log(`[scope] Gmail ouvre : ${opened}`);
    await expect(page.getByRole('dialog').getByText(/what this connector can reach/i)).toHaveCount(
      0,
    );
  });

  test('la PREMIÈRE connexion est un chemin à part, et il est éprouvé', async ({ page }) => {
    // Le cas que l'issue #72 réclamait sans pouvoir le nommer. Sur une
    // installation SANS identifiant Google, le bouton ouvre l'assistant : c'est
    // la toute première fois qu'on donne le jeton, et c'est là que la portée
    // doit se lire. Si un identifiant existe déjà sur cette base, ce chemin
    // n'est pas joignable — le cas le DIT et s'ignore, il ne se tait pas.
    const opened = await openConnectorInstallDialog(page, 'Google Drive');
    test.skip(
      opened !== 'wizard',
      'un identifiant Google compatible existe déjà sur cette base : le bouton ouvre le ' +
        "formulaire d'ajout, et le chemin de PREMIÈRE connexion n'est pas joignable ici. " +
        'Il est éprouvé sur une installation neuve — celle du runner.',
    );

    await expect(page.getByTestId('credential-wizard-dialog')).toBeVisible();
    await expectDisclosure(page, opened, 'Google Drive (première connexion)');
    await expect(page.getByRole('dialog').getByText(/entire google drive/i)).toBeVisible();
  });
});
