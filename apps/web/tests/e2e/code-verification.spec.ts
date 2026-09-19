/**
 * code-verification.spec.ts — le panneau « Proof commands » d'un projet
 * (plan « Vérifier & Corriger », T22 / D9).
 *
 * Il vivait sur l'onglet Code jusqu'à #143 ; il est maintenant sur l'onglet
 * « Files & proof » de la page du projet, ouvert par défaut à côté de ses
 * conversations, et ce parcours l'y trouve.
 *
 * Sept scénarios :
 *   A — configurer puis approuver : la pilule passe à « Needs your approval »
 *       puis à « Approved », et code_projects porte le hash EN BASE ;
 *   B — éditer une commande approuvée retire l'approbation (hash NULL en base) ;
 *   C — le cap de cinq est VISIBLE : à cinq commandes l'ajout n'est plus rendu ;
 *   D — non-owner : champs désactivés, pilule « owner only », pas d'approbation
 *       (non jouable en local-trust, voir le skip) ;
 *   E — un échec serveur ne ment pas : approbation d'un manifeste modifié
 *       derrière le dos de la page ⇒ toast d'erreur et la pilule ne bouge pas ;
 *   F — `/code` mène à Workspaces ; le panneau « Files & proof » d'un projet
 *       se ferme, le choix tient au rechargement, et `/spaces/<id>/files` le
 *       rouvre quand même (#143) ;
 *   G — RIEN ne déborde du panneau, chemin long et commande longue comprises.
 *       Il demande une vraie mise en page, donc un vrai navigateur.
 *
 * PRÉCONDITIONS semées en base, comme telegram-allowlist.spec.ts : un agent,
 * un dossier réel sur le disque (un projet dont le dossier n'existe pas n'est
 * PAS rendu — c'est délibéré, voir deriveProjectRoot) portant un marqueur de
 * projet à sa racine, un job, et un `file_write` dedans. C'est ce qui fait
 * apparaître le projet dans l'onglet ; les ASSERTIONS portent sur l'UI et sur
 * l'effet en base des deux actions serveur.

 *
 * Requiert la stack (web + runner + DB) sur le port 3000.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashVerificationManifest } from '@nodal-agents/shared';
import { requireLiveStack, makeDbClient, testSlugSuffix } from './helpers.ts';
import { codeProjectManifest } from '../../src/lib/verification-display.ts';

const E2E_EMAIL = 'e2e-playwright@nodalai.local';

let entityId = '';
let agentId = '';
let jobId = '';
/** Chemin POSIX (slashes) — c'est la forme que l'app normalise et affiche. */
let projectDir = '';
let projectLabel = '';
/** L'identifiant de la ligne ENREGISTRÉE du projet — sa page (#143). */
let projectId = '';

async function resolveEntity(): Promise<string> {
  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // e2e authentifié (pnpm e2e:up) ou boot local-trust simple : les deux.
    for (const email of [E2E_EMAIL, 'local@nodalai.local']) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!u) continue;
      const [e] = await db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.userId, u.id))
        .limit(1);
      if (e) return e.id;
    }
    throw new Error('No entity found for e2e or local user');
  } finally {
    await close();
  }
}

test.beforeAll(async () => {
  await requireLiveStack();
  entityId = await resolveEntity();

  const suffix = testSlugSuffix();
  projectLabel = `proof-app-${suffix}`;
  projectDir = `${tmpdir().replace(/\\/g, '/')}/nodal-e2e/${projectLabel}`;
  mkdirSync(`${projectDir}/src`, { recursive: true });
  // Marqueur de projet à la RACINE du dossier attaché : sans lui, le projet
  // affiché serait l'enfant direct (`src`) et non le dossier lui-même.
  writeFileSync(`${projectDir}/package.json`, '{"name":"proof-app"}\n', 'utf8');

  const { agents, agentWorkspaces, agentJobs, toolCalls } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId,
        name: `Proof E2E ${suffix}`,
        slug: `proof-e2e-${suffix}`,
        personality: 'p',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;

    await db.insert(agentWorkspaces).values({
      agentId,
      entityId,
      label: projectLabel,
      path: projectDir,
    });

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId,
        task: 'Build the proof app',
        channel: 'api',
        status: 'completed',
      })
      .returning({ id: agentJobs.id });
    jobId = job!.id;

    await db.insert(toolCalls).values({
      entityId,
      jobId,
      toolName: 'file_write',
      toolInput: { file_path: `${projectDir}/src/app.ts`, content: 'export const a = 1;\n' },
      toolOutput: 'ok',
    });
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  const { agents, agentJobs, toolCalls, codeProjects, eq, inArray } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const jobIds = [jobId].filter((id) => id !== '');
    if (jobIds.length > 0) {
      await db.delete(toolCalls).where(inArray(toolCalls.jobId, jobIds));
      await db.delete(agentJobs).where(inArray(agentJobs.id, jobIds));
    }
    const agentIds = [agentId].filter((id) => id !== '');
    if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds));
    const { projectKey } = await import('@nodal-agents/shared');
    if (projectDir) {
      await db.delete(codeProjects).where(eq(codeProjects.projectKey, projectKey(projectDir)));
    }
  } finally {
    await close();
  }
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

/**
 * Remet le projet à « rien de configuré » avant chaque scénario, et le
 * RÉINSCRIT au registre.
 *
 * Depuis #143, le panneau de preuve vit sur la page du projet
 * (`/spaces/<id>/files`) : il faut donc un projet qui AIT une page, c'est-à-dire
 * une ligne enregistrée. Supprimer la ligne et s'en tenir là laissait un dossier
 * seulement détecté — que Workspaces montre bien, mais qui n'ouvre rien tant
 * que personne ne l'a inscrit.
 */
test.beforeEach(async () => {
  const { codeProjects, eq } = await import('@nodal-agents/db');
  const { projectKey } = await import('@nodal-agents/shared');
  const { db, close } = makeDbClient();
  try {
    await db.delete(codeProjects).where(eq(codeProjects.projectKey, projectKey(projectDir)));
    const [row] = await db
      .insert(codeProjects)
      .values({
        entityId,
        projectPath: projectDir,
        projectKey: projectKey(projectDir),
        kind: 'code',
        agentId,
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    projectId = row!.id;
  } finally {
    await close();
  }
});

async function readProjectRow() {
  const { codeProjects, and, eq } = await import('@nodal-agents/db');
  const { projectKey } = await import('@nodal-agents/shared');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({
        verifyCommands: codeProjects.verifyCommands,
        verifyApprovedManifestHash: codeProjects.verifyApprovedManifestHash,
        verifyApprovedAt: codeProjects.verifyApprovedAt,
      })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, entityId),
          eq(codeProjects.projectKey, projectKey(projectDir)),
        ),
      );
    return row ?? null;
  } finally {
    await close();
  }
}

/**
 * Ouvre la page du projet semé et rend son panneau de preuve (#143).
 *
 * Par le PARCOURS, pas par une URL construite : Workspaces, puis la ligne du
 * projet. Le panneau « Files & proof » est OUVERT par défaut, donc la preuve
 * est là sans un clic de plus — et le prendre par ce chemin prouve au passage
 * que la liste ouvre bien le projet.
 *
 * Le stockage local est vidé avant : le panneau garde le choix de la personne
 * d'une visite à l'autre, et un scénario précédent qui l'aurait refermé
 * ferait échouer le suivant pour une raison qui n'a rien à voir avec lui.
 */
async function openProjectPanel(page: Page): Promise<Locator> {
  await page.goto('/spaces');
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('nodal.project-panel-open');
    } catch {
      // Un navigateur qui refuse le stockage rend le défaut, qui est ouvert.
    }
  });
  await page
    .getByRole('link', { name: new RegExp(projectLabel) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/spaces/${projectId}$`));
  await expect(page.getByTestId('project-files-panel')).toBeVisible();
  const panel = page.getByTestId('project-verification');
  await expect(panel).toBeVisible();
  return panel;
}

async function fillCommand(panel: Locator, index: number, command: string, timeout: string) {
  await panel.getByTestId(`verify-command-${index}`).fill(command);
  await panel.getByTestId(`verify-timeout-${index}`).fill(timeout);
}

const addButton = (panel: Locator): Locator => panel.getByRole('button', { name: 'Add a command' });

test.describe('Proof commands — la page du projet @cap:verifier-un-livrable/ecran', () => {
  test('A — configurer puis approuver, hash écrit EN BASE', async ({ page }) => {
    const panel = await openProjectPanel(page);
    // « Nothing declared yet » et non « Not configured » : l'écran ne reproche
    // plus à l'utilisateur un champ qu'il n'a pas rempli. C'est l'agent qui
    // déclare (PR « Prouver sans configurer », 08/09/2026).
    await expect(panel.getByTestId('verify-status')).toHaveText('Nothing declared yet');

    await addButton(panel).click();
    await fillCommand(panel, 0, 'pnpm typecheck', '120');
    await addButton(panel).click();
    await fillCommand(panel, 1, 'pnpm test', '600');
    await panel.getByTestId('verify-save').click();

    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');
    const saved = await readProjectRow();
    expect(saved?.verifyCommands).toEqual([
      { command: 'pnpm typecheck', timeoutSeconds: 120 },
      { command: 'pnpm test', timeoutSeconds: 600 },
    ]);
    expect(saved?.verifyApprovedManifestHash).toBeNull();

    // L'avertissement est là, en toutes lettres, avant le geste.
    await expect(panel.getByText('These commands run code from the repository')).toBeVisible();
    await panel.getByTestId('verify-approve').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('pnpm typecheck')).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve' }).click();

    await expect(panel.getByTestId('verify-status')).toContainText('Approved');
    // Le hash n'est pas « non nul » : c'est CELUI du manifeste, recalculé ici.
    const expected = hashVerificationManifest(
      codeProjectManifest({
        projectPath: projectDir,
        verifyCommands: [
          { command: 'pnpm typecheck', timeoutSeconds: 120 },
          { command: 'pnpm test', timeoutSeconds: 600 },
        ],
      }),
    );
    const approved = await readProjectRow();
    expect(approved?.verifyApprovedManifestHash).toBe(expected);
    expect(approved?.verifyApprovedAt).not.toBeNull();
  });

  test('B — éditer une commande approuvée retire l’approbation', async ({ page }) => {
    const panel = await openProjectPanel(page);
    await addButton(panel).click();
    await fillCommand(panel, 0, 'pnpm test', '300');
    await panel.getByTestId('verify-save').click();
    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');
    await panel.getByTestId('verify-approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(panel.getByTestId('verify-status')).toContainText('Approved');

    // Un timeout suffit : le manifeste change, donc l'approbation tombe.
    await panel.getByTestId('verify-timeout-0').fill('301');
    await panel.getByTestId('verify-save').click();

    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');
    const row = await readProjectRow();
    expect(row?.verifyCommands).toEqual([{ command: 'pnpm test', timeoutSeconds: 301 }]);
    expect(row?.verifyApprovedManifestHash).toBeNull();
    expect(row?.verifyApprovedAt).toBeNull();
  });

  test('C — le cap de cinq est visible : l’ajout disparaît', async ({ page }) => {
    const panel = await openProjectPanel(page);
    for (let i = 0; i < 5; i++) {
      await addButton(panel).click();
      await fillCommand(panel, i, `echo ${i}`, '30');
    }
    await expect(panel.getByTestId('verify-command-4')).toBeVisible();
    await expect(addButton(panel)).toHaveCount(0);
  });

  test('D — non-owner : champs désactivés, pilule owner only, pas d’approbation', async ({
    page,
  }) => {
    const panel = await openProjectPanel(page);
    const ownerOnly = panel.getByText('owner only');
    test.skip(
      (await ownerOnly.count()) === 0,
      'La session est propriétaire (le cas normal, et le seul en local-trust où ' +
        'isWorkspaceOwner rend true pour tout le monde). Le cas non-owner est ' +
        'prouvé unitairement par getCodeTabOwnerAction.',
    );
    await expect(ownerOnly).toBeVisible();
    await expect(
      panel.getByText('Only the workspace owner can change proof commands.'),
    ).toBeVisible();
    await expect(panel.getByTestId('verify-approve')).toHaveCount(0);
    await expect(panel.getByTestId('verify-save')).toHaveCount(0);
    if ((await panel.getByTestId('verify-command-0').count()) > 0) {
      await expect(panel.getByTestId('verify-command-0')).toBeDisabled();
    }
  });

  test('E — un échec serveur ne ment pas', async ({ page }) => {
    const panel = await openProjectPanel(page);
    await addButton(panel).click();
    await fillCommand(panel, 0, 'pnpm test', '300');
    await panel.getByTestId('verify-save').click();
    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');

    // Le manifeste change EN BASE, sans que la page le sache : son jeton est
    // périmé. C'est un vrai échec serveur (conflict), pas une réponse simulée.
    {
      const { codeProjects, and, eq } = await import('@nodal-agents/db');
      const { projectKey } = await import('@nodal-agents/shared');
      const { db, close } = makeDbClient();
      try {
        await db
          .update(codeProjects)
          .set({ verifyCommands: [{ command: 'pnpm test --coverage', timeoutSeconds: 300 }] })
          .where(
            and(
              eq(codeProjects.entityId, entityId),
              eq(codeProjects.projectKey, projectKey(projectDir)),
            ),
          );
      } finally {
        await close();
      }
    }

    await panel.getByTestId('verify-approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: 15_000 });
    // L'écran reste sur l'état d'avant : aucune approbation affichée…
    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');
    // …et rien d'approuvé en base.
    expect((await readProjectRow())?.verifyApprovedManifestHash).toBeNull();
  });

  test('G — RIEN ne déborde du panneau, chemin long et commande longue comprises', async ({
    page,
  }) => {
    // Le constat de Quentin (19/09), sur la stack, thème sombre : le chemin du
    // dossier, la ligne de comptes de la preuve et la carte des commandes
    // étaient coupés au bord droit, avec une barre de défilement horizontale
    // sur la carte.
    //
    // Ce cas est ici et pas en unitaire parce qu'il demande une MISE EN PAGE :
    // jsdom ne calcule aucune largeur, `scrollWidth` et `clientWidth` y valent
    // zéro, et un test qui les comparerait passerait au vert sur n'importe quoi.
    const panel = await openProjectPanel(page);
    await addButton(panel).click();
    await fillCommand(
      panel,
      0,
      'pnpm --filter @nodal-agents/web exec vitest run --reporter=verbose --coverage',
      '600',
    );
    await panel.getByTestId('verify-save').click();
    await expect(panel.getByTestId('verify-status')).toHaveText('Needs your approval');

    // Aucun élément du panneau ne dépasse sa propre boîte. Un pixel de marge
    // pour les arrondis du navigateur, pas plus.
    const debordements = await page.getByTestId('project-files-panel').evaluate((racine) => {
      const trop: string[] = [];
      const voir = (el: Element): void => {
        if (el.scrollWidth - el.clientWidth > 1) {
          trop.push(`${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth}`);
        }
        for (const enfant of el.children) voir(enfant);
      };
      voir(racine);
      return trop;
    });
    expect(debordements, debordements.join(' | ')).toEqual([]);

    // Et le panneau ne pousse pas la page hors de l'écran.
    const pageDeborde = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth > 1,
    );
    expect(pageDeborde).toBe(false);
  });

  test('F — /code mène à Workspaces : la liste a disparu, le panneau est sur le projet', async ({
    page,
  }) => {
    // #143. Le scénario d'avant ouvrait le tiroir « Other sessions » de la
    // liste Code pour vérifier qu'il n'avait aucun panneau. Ce tiroir n'existe
    // plus, et ce qu'il gardait — des sessions sans dossier — n'a jamais eu de
    // preuve à configurer. Ce qui se vérifie maintenant est que la route ne
    // mène nulle part de mort, et que le panneau est là où il doit être.
    await page.goto('/code');
    await expect(page).toHaveURL(/\/spaces$/);
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    // Et le panneau du projet se REFERME : la preuve est à côté des
    // conversations, pas devant elles, et la personne décide.
    await page.goto(`/spaces/${projectId}`);
    await expect(page.getByTestId('project-files-panel')).toBeVisible();
    await page.getByTestId('project-panel-toggle').click();
    await expect(page.getByTestId('project-files-panel')).toHaveCount(0);
    await expect(page.getByTestId('project-verification')).toHaveCount(0);
    // Le choix TIENT d'une visite à l'autre.
    await page.reload();
    await expect(page.getByTestId('project-files-panel')).toHaveCount(0);
    // Mais `/spaces/<id>/files` veut dire « montre-moi le dossier », et il le
    // montre quand même.
    await page.goto(`/spaces/${projectId}/files`);
    await expect(page.getByTestId('project-files-panel')).toBeVisible();
  });
});
