/**
 * Playwright e2e — l'onglet Tools de l'éditeur d'agent.
 *
 * Un « groupe d'outils » est un skill système dont la valeur EST le paquet de
 * builtins qu'il débloque : il se présente comme un interrupteur ici, et il
 * est masqué de toutes les surfaces Skills.
 *
 * ⚠️ CE FICHIER DISAIT LE CONTRAIRE DU PRODUIT. Il tenait `command-execution`
 * pour un groupe d'outils — c'était vrai jusqu'au 25/08/2026, où la règle est
 * passée de DÉDUITE (« un skill système qui garde ≥1 builtin ») à DÉCLARÉE
 * (`toolGroup: true` dans le catalogue), précisément pour rendre à
 * `command-execution` son statut de skill : sa charge utile est une
 * discipline (« n'installe jamais de logiciel lourd de ta propre initiative »),
 * et rangée sous Tools son propriétaire ne pouvait plus ni la lire ni l'éditer.
 * La mesure du 11/09 le disait :
 *
 *   expect(locator).toBeVisible() failed
 *   Locator: locator('[data-testid="tool-group-card-command-execution"]')
 *   Error: element(s) not found
 *
 * Les cinq groupes ne sont donc plus écrits en dur : ils viennent du CATALOGUE
 * (`toolGroupSkillSlugs`), seule source qui ne peut pas mentir. Un skill qui
 * change de camp fait bouger ce parcours tout seul, et l'étape 5 prouve
 * désormais l'autre moitié de la décision : `command-execution` EST un skill.
 *
 * Second défaut, invisible dans le rapport : `agentEditUrl` était une variable
 * de module remplie par l'étape 1. À la reprise d'un cas rouge, Playwright
 * recharge le fichier sans rejouer l'étape 1 — la variable était vide, l'étape
 * se déclarait « ignorée », et le cas ressortait « flaky » alors que rien
 * n'était intermittent. Chaque cas résout désormais son agent lui-même.
 */

import { test, expect, type Page } from '@playwright/test';
import { toolGroupSkillSlugs, systemSkills } from '@nodal-agents/catalog';
import { requireLiveStack } from './helpers.ts';

test.describe.configure({ timeout: 60_000 });

/** Le skill du catalogue portant ce slug — sa source de vérité pour le nom. */
function catalogSkill(slug: string) {
  const s = systemSkills.find((x) => x.slug === slug);
  if (!s) throw new Error(`slug ${slug} absent du catalogue`);
  return s;
}

/** Un groupe d'outils au hasard mais stable : le premier du catalogue. */
const FIRST_GROUP = toolGroupSkillSlugs[0]!;

/**
 * L'URL d'édition du premier agent visible, résolue à CHAQUE cas (plus de
 * variable de module partagée entre les cas et perdue à la reprise).
 */
async function firstAgentEditUrl(page: Page): Promise<string> {
  await page.goto('/agents');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  const editLinks = page.locator('a[href*="/agents/"][href$="/edit"]');
  const count = await editLinks.count();
  if (count === 0) {
    test.skip(true, 'Aucun agent sur cette installation — rien à éditer.');
  }
  const href = await editLinks.first().getAttribute('href');
  if (!href) test.skip(true, "Le premier agent n'expose pas de lien d'édition.");
  return href!;
}

/**
 * Ouvre l'onglet dont le libellé COMMENCE par `label`. La TabsBar rend chaque
 * onglet en `<div role="tab">`, et le libellé peut être suivi d'un compteur
 * mono sans espace (« Skills1 ») — d'où le préfixe.
 */
async function goToTab(page: Page, editUrl: string, label: string): Promise<void> {
  await page.goto(editUrl);
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  const tab = page.getByRole('tab', { name: new RegExp(`^${label}`, 'i') }).first();
  await tab.click();
  // On attend que l'onglet SOIT sélectionné, pas 600 ms de montre.
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 8_000 });
}

test.beforeAll(async () => {
  await requireLiveStack();
});

// ─── 1. Les groupes du catalogue sont tous là ────────────────────────────────

test('Tools tab lists every tool group the catalogue declares @cap:assigner-outils', async ({
  page,
}) => {
  const editUrl = await firstAgentEditUrl(page);
  await goToTab(page, editUrl, 'Tools');

  expect(toolGroupSkillSlugs.length).toBeGreaterThan(0);
  for (const slug of toolGroupSkillSlugs) {
    const card = page.locator(`[data-testid="tool-group-card-${slug}"]`);
    await expect(card, `pas de carte pour le groupe ${slug}`).toBeVisible({ timeout: 8_000 });
    await expect(card.getByText(catalogSkill(slug).name, { exact: true })).toBeVisible();
  }

  // Et rien d'autre : un skill ordinaire n'a pas d'interrupteur ici.
  await expect(page.locator('[data-testid="tool-group-card-command-execution"]')).toHaveCount(0);
});

// ─── 2. La divulgation liste les vrais builtins ──────────────────────────────

test('disclosure expands to show the gated tool names as chips', async ({ page }) => {
  const editUrl = await firstAgentEditUrl(page);
  await goToTab(page, editUrl, 'Tools');

  const skill = catalogSkill(FIRST_GROUP);
  const builtins = skill.requiredBuiltins ?? [];
  expect(builtins.length).toBeGreaterThan(0);

  const card = page.locator(`[data-testid="tool-group-card-${FIRST_GROUP}"]`);
  const label = builtins.length === 1 ? '1 tool' : `${builtins.length} tools`;
  const disclosure = card.getByText(new RegExp(`^${label}$`));
  await expect(disclosure).toBeVisible({ timeout: 8_000 });
  await disclosure.click();

  // Les puces sont les noms RÉELS du catalogue, pas un décompte.
  await expect(card.locator('code')).toHaveCount(builtins.length, { timeout: 6_000 });
  for (const name of builtins) {
    await expect(card.locator('code', { hasText: name }).first()).toBeVisible();
  }
});

// ─── 3. La guidance s'ouvre en lecture seule ─────────────────────────────────

test('"Includes guidance" badge opens a read-only modal with the skill content', async ({
  page,
}) => {
  const editUrl = await firstAgentEditUrl(page);
  await goToTab(page, editUrl, 'Tools');

  const skill = catalogSkill(FIRST_GROUP);
  const card = page.locator(`[data-testid="tool-group-card-${FIRST_GROUP}"]`);
  await card.getByRole('button', { name: /includes guidance/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 6_000 });
  await expect(dialog.locator('h3')).toHaveText(skill.name);

  // Le contenu affiché est bien CELUI du skill : on vérifie sa première ligne
  // de titre markdown, pas une phrase recopiée à la main.
  const firstHeading = (skill.content ?? '').split('\n').find((l) => l.startsWith('## '));
  if (firstHeading) {
    await expect(
      dialog.getByText(firstHeading.replace(/^##\s+/, ''), { exact: false }),
    ).toBeVisible({ timeout: 4_000 });
  }

  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).not.toBeVisible({ timeout: 4_000 });
});

// ─── 4. Les deux moitiés de la décision du 25/08 ─────────────────────────────

test("tool groups are absent from the agent's Skills tab, command-execution is NOT", async ({
  page,
}) => {
  const editUrl = await firstAgentEditUrl(page);
  await goToTab(page, editUrl, 'Skills');

  const bodyText = await page.locator('body').innerText();
  for (const slug of toolGroupSkillSlugs) {
    expect(bodyText, `${slug} ne doit pas apparaître dans Skills`).not.toContain(
      catalogSkill(slug).name,
    );
  }
  // L'autre moitié : un skill qui porte une DISCIPLINE reste un skill, lisible
  // et éditable par son propriétaire. C'est la raison même du changement.
  expect(bodyText).toContain(catalogSkill('command-execution').name);
});

// ─── 5. Assigné ne veut pas dire visible dans /skills ────────────────────────

test('a tool group assigned to this agent is still absent from /skills Assigned', async ({
  page,
}) => {
  const editUrl = await firstAgentEditUrl(page);
  const skill = catalogSkill(FIRST_GROUP);

  // On l'allume pour de vrai, sinon l'exclusion plus bas serait vraie sans
  // rien prouver (assignmentCount = 0).
  await goToTab(page, editUrl, 'Tools');
  // Chaîne littérale et non RegExp : le nom d'un groupe peut contenir des
  // parenthèses (« Office editing (all formats) »), qui sont des
  // métacaractères. `getByRole` fait une comparaison exacte sur une chaîne.
  const toolSwitch = page.getByRole('switch', { name: `Toggle ${skill.name}` });
  await toolSwitch.waitFor({ state: 'visible', timeout: 8_000 });
  if ((await toolSwitch.getAttribute('aria-checked')) !== 'true') {
    await toolSwitch.click();
    await expect(toolSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 8_000 });
  }

  await page.goto('/skills');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  const assignedTab = page.getByRole('tab', { name: /^assigned/i });
  if (await assignedTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await assignedTab.click();
    await expect(assignedTab).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
  }

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(skill.name);
});
