import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '@nodal-agents/db';
import type { CredentialType } from '@nodal-agents/shared';
import {
  cleanCredentialsOfType,
  cleanupOptionsFromEnv,
  dropRunCredentials,
  E2E_RUN_ID,
} from './credential-cleanup.ts';

export {
  E2E_CREDENTIAL_MARKER_OPEN,
  E2E_CREDENTIAL_MARKER_CLOSE,
  E2E_RUN_ID,
  e2eCredentialMarker,
  e2eCredentialName,
  isE2ECredentialName,
  isCredentialOfRun,
} from './credential-cleanup.ts';

/**
 * Skip the entire test file when the Nodal-Agents stack isn't reachable. Every
 * e2e file calls `requireLiveStack(test)` in a beforeAll so a missing
 * server fails fast and obvious rather than minutes of nav timeouts.
 */
export async function requireLiveStack(): Promise<void> {
  const baseURL = base.info().project.use.baseURL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${baseURL}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      base.skip(true, `Nodal-Agents /api/health returned ${res.status}`);
    }
  } catch (err) {
    base.skip(true, `Nodal-Agents not reachable at ${baseURL}: ${(err as Error).message}`);
  }
}

/**
 * A short slug suffix to keep test runs independent on a shared DB.
 * Format: e2e-<6 random chars>.
 */
export function testSlugSuffix(): string {
  return `e2e-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── La page Connecteurs ──────────────────────────────────────────────────────
//
// Huit parcours tapaient encore sur l'ancienne page : une `<section>` intitulée
// « Marketplace » (niveau 2), une autre « Active Connectors », et un bouton
// « Connect with Google » par carte. Plus rien de tout cela n'existe depuis la
// refonte : la page ouvre sur l'onglet « Installed » (un TABLEAU, pas des
// cartes), le catalogue vit derrière l'onglet « Library », et la carte porte un
// seul bouton, « Install » ou « Add account » selon qu'une instance existe déjà.
//
// Ces trois gestes sont donc écrits UNE fois ici. Un parcours qui les recopie
// est un parcours qui redeviendra rouge à la prochaine refonte sans que
// personne ne s'en aperçoive — c'est très exactement ce qui s'est passé.

/** Ouvre /connecteurs sur l'onglet catalogue (« Library »). */
export async function openConnectorLibrary(page: Page): Promise<void> {
  await page.goto('/connectors');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  // PAS /^library$/ : l'onglet DS replie un compteur dans son libellé, donc le
  // nom accessible est « Library · 15 » et grandit avec le catalogue.
  await page.getByRole('tab', { name: /library/i }).click();
}

/** Ouvre /connecteurs sur l'onglet des instances installées. */
export async function openInstalledConnectors(page: Page): Promise<void> {
  await page.goto('/connectors');
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  await page.getByRole('tab', { name: /installed/i }).click();
}

/**
 * La carte catalogue d'un connecteur, désignée par son ANCRE (`data-testid`
 * dérivé du libellé dans MarketplaceCard) et non par une classe de mise en
 * forme — le `rounded-xl` devenu `rounded-2xl` avait rendu huit parcours
 * rouges d'un coup, en silence, sans qu'une fonctionnalité soit cassée.
 */
export function connectorCard(page: Page, label: string): Locator {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return page.getByTestId(`marketplace-card-${slug}`);
}

/**
 * Ouvre la modale d'installation d'un connecteur depuis le catalogue et rend
 * la main quand un dialogue est à l'écran.
 *
 * ⚠️ ce dialogue n'est pas toujours le même : pour un connecteur OAuth dont
 * AUCUN identifiant compatible n'existe encore, la carte ouvre directement le
 * CredentialWizard (ConnectorsMarketplaceGrid, `needsWizard`). C'est le cas sur
 * une installation neuve — donc sur le runner.
 *
 * Rend LEQUEL des deux s'est ouvert, pour qu'un appelant puisse le dire au
 * lieu de le supposer (issue #72).
 */
export async function openConnectorInstallDialog(
  page: Page,
  label: string,
): Promise<ConnectorDialogKind> {
  await openConnectorLibrary(page);
  const card = connectorCard(page, label);
  await expect(card, `aucune carte catalogue pour « ${label} »`).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: /^(install|add account)$/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  return openedConnectorDialog(page);
}

/**
 * LAQUELLE des deux modales du bouton s'est ouverte.
 *
 * `wizard` — aucun identifiant compatible n'existe : c'est la PREMIÈRE fois
 * qu'on connecte ce fournisseur (`CredentialWizard`).
 * `add-form` — un identifiant existe déjà, et on choisit lequel utiliser
 * (`ConnectorAddForm`).
 *
 * Les deux portent `role="dialog"` et ne se distinguaient jusqu'ici que par
 * leur TITRE affiché. Un parcours qui ne sait pas laquelle il a devant lui peut
 * passer au vert sur le mauvais chemin : c'est toute l'issue #72, où le même
 * cas était vert sur la machine du propriétaire — un compte Google y existait —
 * et rouge sur un runner neuf, sans que rien ne dise que les deux ne prouvaient
 * pas la même chose.
 */
export type ConnectorDialogKind = 'wizard' | 'add-form';

export async function openedConnectorDialog(page: Page): Promise<ConnectorDialogKind> {
  if (await page.getByTestId('credential-wizard-dialog').isVisible()) return 'wizard';
  if (await page.getByTestId('connector-add-dialog').isVisible()) return 'add-form';
  throw new Error(
    'CONNECTOR_DIALOG_UNKNOWN : une modale est ouverte mais ne porte ni ' +
      '`credential-wizard-dialog` ni `connector-add-dialog`. Le parcours ne peut pas dire ' +
      'quel chemin il éprouve, et un vert ne vaudrait alors rien.',
  );
}

/**
 * La LIGNE d'une instance installée. Ce n'est plus une carte depuis la refonte
 * mais une ligne de tableau (ConnectorsInstalledTable) : colonne « Account » =
 * le nom du compte de l'identifiant, à défaut le nom de l'instance.
 */
export function installedConnectorRow(page: Page, instanceName: string): Locator {
  return page.getByRole('row').filter({ hasText: instanceName });
}

/**
 * Supprime une instance installée si elle est là, par les VRAIS gestes (bouton
 * de ligne + ConfirmDialog) ; ne fait rien si elle n'existe pas. Sert de
 * nettoyage d'avant-course, jamais d'assertion.
 */
export async function removeInstalledConnectorIfPresent(
  page: Page,
  instanceName: string,
): Promise<void> {
  await openInstalledConnectors(page);
  // Laisser l'onglet rendre : `count()` sur un tableau pas encore monté rend 0
  // sans attendre, et le nettoyage passerait à côté d'une instance présente.
  await page
    .getByRole('row')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {
      /* aucune ligne du tout : l'onglet est vide, il n'y a rien à nettoyer. */
    });
  const row = installedConnectorRow(page, instanceName);
  const matches = await row.count();
  if (matches === 0) return;
  // `hasText` est une correspondance PARTIELLE : « Google » attrape « Google
  // Drive », et deux comptes du même connecteur donnent deux lignes. Le
  // `.first()` d'avant choisissait donc au hasard — et le geste qui suit est
  // une SUPPRESSION, pas une lecture.
  if (matches > 1) {
    throw new Error(
      `« ${instanceName} » désigne ${matches} lignes de la table des connecteurs installés. ` +
        "Refus de supprimer au hasard : donner un nom qui ne désigne qu'une ligne.",
    );
  }
  // Le titre du bouton est « Disconnect » pour un OAuth, « Delete » sinon.
  await row.getByRole('button', { name: /^(delete|disconnect)$/i }).click();
  const confirm = page.getByRole('dialog');
  await confirm.waitFor({ state: 'visible', timeout: 5_000 });
  await confirm.getByRole('button', { name: /^(delete|disconnect)$/i }).click();
  await expect(page.getByText(`${instanceName} removed`)).toBeVisible({ timeout: 10_000 });
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * The port the embedded Postgres is ACTUALLY listening on, read from its own
 * lockfile (`postmaster.pid` line 4 — the standard layout: pid, data dir, start
 * time, port, socket dir, listen address).
 *
 * This used to be the literal `25433`, and on 2026-08-11 that single number was
 * failing THIRTEEN specs at once — a third of the suite. The cluster read as
 * thirteen broken journeys ("Failed query: select id from users…", Drizzle
 * hiding the ECONNREFUSED in `err.cause` as usual) when it was one wrong port:
 * `up` walks upward from 25432 when the port is taken, and this machine had
 * landed on 25436. Nobody could have noticed, because these specs had not been
 * replayed since the port drifted.
 *
 * Reading the lockfile is also the only form that is correct on someone else's
 * machine — a hardcoded port is invariant #6 (no per-user values) written in a
 * test. NODALAI_E2E_DB_URL overrides for a stack running elsewhere.
 *
 * The PASSWORD had drifted the same way and for a better reason: SECRET-003
 * (audit 2026-08-07) stopped shipping the literal `nodalai` to every install and
 * mints one per machine into config.json. So the hardcoded credential had been
 * dead since 8 August, and again nothing said so. It is read from the same
 * config the runner uses, falling back to the legacy value only for a cluster
 * created before the rotation — the same back-compat rule as the CLI's.
 */
function resolveDbUrl(): string {
  const override = process.env['NODALAI_E2E_DB_URL'];
  if (override) return override;

  const pidFile = join(homedir(), '.nodalai', 'pg-data', 'postmaster.pid');
  let port: number;
  try {
    const line = readFileSync(pidFile, 'utf8').split('\n')[3]?.trim() ?? '';
    port = Number.parseInt(line, 10);
  } catch (err) {
    throw new Error(
      `Cannot read the Postgres port from ${pidFile} (${(err as Error).message}). ` +
        'Is the stack running? Start it with `nodal-agents up`, or point the tests at ' +
        'another stack with NODALAI_E2E_DB_URL.',
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${pidFile} line 4 is not a port ("${port}"). Refusing to guess — set NODALAI_E2E_DB_URL.`,
    );
  }

  const configPath =
    process.env['NODALAI_CONFIG_PATH'] ?? join(homedir(), '.nodalai', 'config.json');
  let password = 'nodalai';
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { postgresPassword?: unknown };
    if (typeof cfg.postgresPassword === 'string' && cfg.postgresPassword.length > 0) {
      password = cfg.postgresPassword;
    }
  } catch (err) {
    throw new Error(
      `Cannot read ${configPath} (${(err as Error).message}) — the Postgres password lives there ` +
        'since SECRET-003. Set NODALAI_E2E_DB_URL to bypass.',
    );
  }

  return `postgresql://nodalai:${encodeURIComponent(password)}@localhost:${port}/nodalai`;
}

/** Create a Drizzle client for the local embedded Postgres instance. */
export function makeDbClient() {
  return createClient(resolveDbUrl());
}

/**
 * Poll a DB query until the predicate returns a non-null truthy value or the
 * timeout (ms) elapses. Returns the first truthy value.
 */
export async function pollDb<T>(
  query: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 120_000, intervalMs = 2_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await query();
    if (result !== null && result !== undefined) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollDb: timed out after ${timeoutMs}ms`);
}

/**
 * Get all tool_calls for a job (all tools).
 */
export async function getAllToolCallsForJob(
  jobId: string,
): Promise<Array<{ id: string; toolName: string; toolInput: unknown }>> {
  const { toolCalls, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await db
      .select({ id: toolCalls.id, toolName: toolCalls.toolName, toolInput: toolCalls.toolInput })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, jobId));
  } finally {
    await close();
  }
}

/** L'adresse que `seedLocalUser` (packages/auth) pose en mode local-trust. */
const LOCAL_TRUST_EMAIL = 'local@nodalai.local';

/**
 * L'utilisateur au nom de qui le dashboard agit, et son espace.
 *
 * Il n'y a PAS un utilisateur e2e : il y en a deux, selon le mode d'auth de la
 * pile, exactement comme `global-setup.ts` le découvre déjà pour la session du
 * navigateur.
 *
 *  - `local-auth` : le compte sentinelle de global-setup
 *    (`e2e-playwright@nodalai.local`, surchargeable par `E2E_EMAIL`).
 *  - `local-trust` : le mode PAR DÉFAUT, et celui de la mesure nocturne. Il n'y
 *    a alors aucun compte sentinelle — `seedLocalUser` pose
 *    `local@nodalai.local` sur des UUID fixes, et c'est cet utilisateur-là que
 *    le serveur voit à chaque requête.
 *
 * Deux parcours résolvaient l'utilisateur par l'adresse sentinelle en dur et
 * mouraient donc sur « E2E user e2e-playwright@nodalai.local not found in DB »
 * à chaque mesure nocturne, sans qu'aucune fonctionnalité soit en cause.
 *
 * La sonde est comportementale (on demande au SERVEUR ce qu'il fait), pas
 * déclarative : le process Playwright ne partage pas forcément l'environnement
 * de la pile. Si aucune des deux lignes ne rend de ligne en base, on échoue
 * bruyamment avec les deux pistes essayées — jamais de repli silencieux.
 */
export async function resolveActingUser(): Promise<{ userId: string; entityId: string }> {
  const baseURL = base.info().project.use.baseURL ?? 'http://localhost:3000';
  const sentinelEmail = process.env['E2E_EMAIL'] ?? 'e2e-playwright@nodalai.local';

  // Une sonde qui ÉCHOUE ne dit pas « local-trust », elle ne dit rien. Le
  // `catch` rendait pourtant `false`, donc « local-trust », donc un utilisateur
  // — le mauvais si la pile était en local-auth et que la ligne local-trust
  // traînait encore en base. Un repli silencieux (invariant #4) dans la
  // fonction dont TOUT le reste dépend, y compris la suppression
  // d'identifiants. Une panne de sonde échoue maintenant bruyamment ; seule une
  // RÉPONSE du serveur, quel que soit son code, tranche le mode.
  let betterAuthAvailable: boolean;
  try {
    const probe = await fetch(`${baseURL}/api/auth/get-session`, {
      headers: { Origin: baseURL },
      signal: AbortSignal.timeout(10_000),
    });
    betterAuthAvailable = probe.ok;
  } catch (err) {
    throw new Error(
      `Impossible de savoir dans quel mode d'auth tourne la pile de ${baseURL} : ` +
        `la sonde /api/auth/get-session n'a pas répondu (${(err as Error).message}). ` +
        "Refus de deviner — l'utilisateur choisi commande ensuite des suppressions en base.",
    );
  }

  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const userId = betterAuthAvailable
      ? (
          await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, sentinelEmail))
            .limit(1)
        )[0]?.id
      : (
          await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, LOCAL_TRUST_EMAIL))
            .limit(1)
        )[0]?.id;

    if (!userId) {
      throw new Error(
        `Aucun utilisateur en base pour la pile de ${baseURL}. ` +
          `Mode détecté : ${betterAuthAvailable ? 'local-auth' : 'local-trust'}, ` +
          `adresse cherchée : ${betterAuthAvailable ? sentinelEmail : LOCAL_TRUST_EMAIL}.`,
      );
    }

    const entityId = (
      await db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.userId, userId))
        .limit(1)
    )[0]?.id;
    if (!entityId) throw new Error(`Aucun espace (entity) pour l'utilisateur ${userId}.`);

    return { userId, entityId };
  } finally {
    await close();
  }
}

/**
 * Supprime les identifiants d'UN type pour l'utilisateur au nom duquel le
 * dashboard agit.
 *
 * POUR NETTOYAGE / REMISE À ZÉRO SEULEMENT — jamais pour supprimer un
 * identifiant qu'un test affirme ensuite avoir été créé par le parcours.
 *
 * Deux corrections ici, toutes deux silencieuses jusqu'à la mesure nocturne :
 *  - le propriétaire était le compte sentinelle en dur, donc en local-trust la
 *    fonction ne trouvait personne et ne nettoyait RIEN (`return` muet) ;
 *  - le filtre sur le type avait été retiré volontairement, ce qui faisait de
 *    ce nettoyage une purge de TOUS les identifiants du propriétaire. Sur la
 *    machine d'un développeur en local-trust, c'est son vrai compte Google que
 *    `beforeAll` effaçait. Le filtre est rétabli : il suffit au besoin réel.
 *
 * Restait la moitié du danger : le filtre protège les AUTRES types, pas le
 * compte Google réel du développeur quand le type demandé est justement
 * `google-oauth`. La suppression se DEMANDAIT donc pour TOUT identifiant du
 * type, et c'est ce qui a rendu les parcours dépendants de leur ordre : la
 * mesure du 15/09 voyait `help-guides` et `oauth-flow` rouges parce que
 * `credentials-reuse` avait laissé son propre identifiant Google derrière lui.
 *
 * Il y a maintenant un marqueur : tout identifiant créé par un parcours porte
 * `[nodalai-e2e:<runId>]` À LA FIN de son nom (`e2eCredentialName`). Ceux de CE
 * run sont effacés sans rien demander ; ceux d'un AUTRE run e2e sont laissés en
 * place et signalés (deux machines peuvent partager `NODALAI_E2E_DB_URL`) ; ceux
 * qui n'ont pas de marqueur — un compte connecté à la main — ne sont JAMAIS
 * effacés sans `NODALAI_E2E_WIPE_CREDENTIALS=1`, et leur présence fait échouer
 * bruyamment le `beforeAll` avec la marche à suivre.
 *
 * La décision ET la suppression vivent dans `credential-cleanup.ts`, qui est
 * testé sous vitest contre un vrai Postgres. Ici il ne reste que le câblage :
 * qui agit, sur quelle base.
 */
export async function cleanCredentialsByType(type: CredentialType): Promise<void> {
  const { userId } = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    await cleanCredentialsOfType(db, userId, type, {
      runId: E2E_RUN_ID,
      ...cleanupOptionsFromEnv(),
    });
  } finally {
    await close();
  }
}

/**
 * Nettoyage de FIN de parcours : efface les identifiants que CE run a créés, et
 * eux seuls (marqueur `[nodalai-e2e:<runId>]` en fin de nom).
 *
 * À appeler dans un `afterAll`, y compris quand le parcours a échoué en cours
 * de route — c'est ce qui rend les parcours indépendants de leur ordre. Ne
 * lève jamais : un nettoyage qui échoue ne doit pas transformer un parcours
 * vert en rouge, et la garde du `beforeAll` suivant rattrape le reste.
 */
export async function dropE2ECredentials(type: CredentialType): Promise<void> {
  try {
    const { userId } = await resolveActingUser();
    const { db, close } = makeDbClient();
    try {
      await dropRunCredentials(db, userId, type, E2E_RUN_ID);
    } finally {
      await close();
    }
  } catch (err) {
    console.warn(`e2e: cleanup of « ${type} » credentials failed: ${(err as Error).message}`);
  }
}

/**
 * Insert a memory row directly into the DB.
 *
 * FOR FIXTURE/CONTEXT DATA ONLY — e.g. pre-existing user preferences set
 * outside the agent flow. NEVER use this to seed data that a test will then
 * assert was produced by an agent. Assertion-target memories must be created
 * by the agent via the real save_memory tool call so the test validates the
 * actual pipeline (save_memory → DB → query_memory → result).
 */
export async function insertMemory(
  entityId: string,
  fact: string,
  opts: { source?: string; category?: string; agentId?: string } = {},
): Promise<string> {
  const { agentMemory } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .insert(agentMemory)
      .values({
        entityId,
        fact,
        source: (opts.source ?? 'manual') as 'manual' | 'agent' | 'reflection',
        category: (opts.category ?? 'context') as
          | 'preference'
          | 'context'
          | 'outcome'
          | 'learned_rule',
        agentId: opts.agentId ?? null,
      })
      .returning({ id: agentMemory.id });
    return row!.id;
  } finally {
    await close();
  }
}
