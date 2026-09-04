/**
 * code-verification.spec.ts — le panneau « Proof commands » de l'onglet Code
 * (plan « Vérifier & Corriger », T22 / D9).
 *
 * Six scénarios :
 *   A — configurer puis approuver : la pilule passe à « Needs your approval »
 *       puis à « Approved », et code_projects porte le hash EN BASE ;
 *   B — éditer une commande approuvée retire l'approbation (hash NULL en base) ;
 *   C — le cap de cinq est VISIBLE : à cinq commandes l'ajout n'est plus rendu ;
 *   D — non-owner : champs désactivés, pilule « owner only », pas d'approbation
 *       (non jouable en local-trust, voir le skip) ;
 *   E — un échec serveur ne ment pas : approbation d'un manifeste modifié
 *       derrière le dos de la page ⇒ toast d'erreur et la pilule ne bouge pas ;
 *   F — le tiroir « Other sessions » n'a AUCUN panneau (pas de chemin, donc
 *       aucune ligne code_projects à écrire).
 *
 * PRÉCONDITIONS semées en base, comme telegram-allowlist.spec.ts : un agent,
 * un dossier réel sur le disque (un projet dont le dossier n'existe pas n'est
 * PAS rendu — c'est délibéré, voir deriveProjectRoot) portant un marqueur de
 * projet à sa racine, un job, et un `file_write` dedans. C'est ce qui fait
 * apparaître le projet dans l'onglet ; les ASSERTIONS portent sur l'UI et sur
 * l'effet en base des deux actions serveur.
 *
 * Le tiroir « Other sessions » est semé lui aussi, et de la seule façon
 * déterministe : un agent SANS dossier attaché, dont le pipeline n'a qu'un
 * `code_task` en écriture. Il qualifie (outil spécifique au code, aucun dossier
 * masqué à contourner) et aucun chemin ne s'en dérive.
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
let orphanAgentId = '';
let jobId = '';
let orphanJobId = '';
/** Chemin POSIX (slashes) — c'est la forme que l'app normalise et affiche. */
let projectDir = '';
let projectLabel = '';

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

    // Le tiroir « Other sessions » : un agent sans dossier, un code_task en
    // écriture, aucun chemin. Rien à nommer, donc pas de projet.
    const [orphan] = await db
      .insert(agents)
      .values({
        entityId,
        name: `Proof E2E orphan ${suffix}`,
        slug: `proof-e2e-orphan-${suffix}`,
        personality: 'p',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    orphanAgentId = orphan!.id;

    const [orphanJob] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: orphanAgentId,
        task: 'Delegate to the CLI, nowhere in particular',
        channel: 'api',
        status: 'completed',
      })
      .returning({ id: agentJobs.id });
    orphanJobId = orphanJob!.id;

    await db.insert(toolCalls).values({
      entityId,
      jobId: orphanJobId,
      toolName: 'code_task',
      toolInput: { mode: 'write', task: 'anything' },
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
    const jobIds = [jobId, orphanJobId].filter((id) => id !== '');
    if (jobIds.length > 0) {
      await db.delete(toolCalls).where(inArray(toolCalls.jobId, jobIds));
      await db.delete(agentJobs).where(inArray(agentJobs.id, jobIds));
    }
    const agentIds = [agentId, orphanAgentId].filter((id) => id !== '');
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

/** Remet le projet à « rien de configuré » avant chaque scénario. */
test.beforeEach(async () => {
  const { codeProjects, eq } = await import('@nodal-agents/db');
  const { projectKey } = await import('@nodal-agents/shared');
  const { db, close } = makeDbClient();
  try {
    await db.delete(codeProjects).where(eq(codeProjects.projectKey, projectKey(projectDir)));
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

/** Ouvre l'écran du projet semé et rend son panneau de preuve. */
async function openProjectPanel(page: Page): Promise<Locator> {
  await page.goto('/code');
  await page
    .getByRole('button', { name: new RegExp(projectLabel) })
    .first()
    .click();
  const panel = page.getByTestId('project-verification');
  await expect(panel).toBeVisible();
  return panel;
}

async function fillCommand(panel: Locator, index: number, command: string, timeout: string) {
  await panel.getByTestId(`verify-command-${index}`).fill(command);
  await panel.getByTestId(`verify-timeout-${index}`).fill(timeout);
}

const addButton = (panel: Locator): Locator => panel.getByRole('button', { name: 'Add a command' });

test.describe('Proof commands — onglet Code', () => {
  test('A — configurer puis approuver, hash écrit EN BASE', async ({ page }) => {
    const panel = await openProjectPanel(page);
    await expect(panel.getByTestId('verify-status')).toHaveText('Not configured');

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

  test('F — le tiroir Other sessions n’a aucun panneau', async ({ page }) => {
    await page.goto('/code');
    await page
      .getByRole('button', { name: /Other sessions/ })
      .first()
      .click();
    await expect(page.getByTestId('project-verification')).toHaveCount(0);
  });
});
