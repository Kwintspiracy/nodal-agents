import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '@nodal-agents/db';
import type { CredentialType } from '@nodal-agents/shared';

/**
 * SEC-1: read the runner's WORKER_SECRET from the live config at runtime rather
 * than hardcoding it. A real 256-bit secret committed to a (public) repo is a
 * leaked credential; the e2e stack the helper talks to already has the real
 * secret in ~/.nodalai/config.json (written by `nodalai up`). Fail loud if it
 * isn't there — never fall back to a baked-in value.
 */
function readWorkerSecret(): string {
  const path = process.env['NODALAI_CONFIG_PATH'] ?? join(homedir(), '.nodalai', 'config.json');
  let cfg: { workerSecret?: unknown };
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as { workerSecret?: unknown };
  } catch (err) {
    throw new Error(
      `e2e: cannot read WORKER_SECRET from ${path} (${(err as Error).message}). ` +
        'Boot the stack first (`nodalai up`) so the runner secret exists.',
    );
  }
  if (typeof cfg.workerSecret !== 'string' || cfg.workerSecret.length === 0) {
    throw new Error(`e2e: no "workerSecret" in ${path} — cannot authenticate to the runner.`);
  }
  return cfg.workerSecret;
}

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
 */
export async function openConnectorInstallDialog(page: Page, label: string): Promise<void> {
  await openConnectorLibrary(page);
  const card = connectorCard(page, label);
  await expect(card, `aucune carte catalogue pour « ${label} »`).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: /^(install|add account)$/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
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
  const row = installedConnectorRow(page, instanceName);
  if (
    !(await row
      .first()
      .isVisible()
      .catch(() => false))
  )
    return;
  // Le titre du bouton est « Disconnect » pour un OAuth, « Delete » sinon.
  await row
    .first()
    .getByRole('button', { name: /^(delete|disconnect)$/i })
    .click();
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
 * Poll until the job (by id) reaches status=completed or status=failed.
 * Returns the full job row.
 */
export async function waitForJob(jobId: string, timeoutMs = 120_000) {
  const { agentJobs, eq, or } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await pollDb(
      async () => {
        const rows = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
        const row = rows[0];
        if (!row) return null;
        if (row.status === 'completed' || row.status === 'failed') return row;
        return null;
      },
      { timeoutMs },
    );
  } finally {
    await close();
  }
}

/**
 * Find memories for an entity created after a given timestamp that contain the
 * given keyword (case-insensitive). Polls until at least `minCount` are found.
 */
export async function waitForMemories(
  entityId: string,
  keyword: string,
  opts: { minCount?: number; timeoutMs?: number; afterMs?: number } = {},
): Promise<Array<{ id: string; fact: string; source: string | null; agentId: string | null }>> {
  const { minCount = 1, timeoutMs = 120_000, afterMs = Date.now() - 5_000 } = opts;
  const { agentMemory, eq, and, ilike } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await pollDb(
      async () => {
        const rows = await db
          .select({
            id: agentMemory.id,
            fact: agentMemory.fact,
            source: agentMemory.source,
            agentId: agentMemory.agentId,
            createdAt: agentMemory.createdAt,
          })
          .from(agentMemory)
          .where(
            and(
              eq(agentMemory.entityId, entityId),
              ilike(agentMemory.fact, `%${keyword}%`),
              eq(agentMemory.archived, false),
            ),
          );
        // Filter by creation time (after test started)
        const fresh = rows.filter((r) => r.createdAt !== null && r.createdAt.getTime() >= afterMs);
        if (fresh.length >= minCount) return fresh;
        return null;
      },
      { timeoutMs },
    );
  } finally {
    await close();
  }
}

/**
 * Query tool_calls for a given job, returning rows where toolName matches.
 */
export async function getToolCallsForJob(
  jobId: string,
  toolName: string,
): Promise<Array<{ id: string; toolName: string; toolInput: unknown; toolOutput: string | null }>> {
  const { toolCalls, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await db
      .select({
        id: toolCalls.id,
        toolName: toolCalls.toolName,
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
      })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, toolName)));
  } finally {
    await close();
  }
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

/**
 * Get child jobs (jobs where parentJobId = the given id).
 */
export async function getChildJobs(parentJobId: string) {
  const { agentJobs, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await db
      .select({
        id: agentJobs.id,
        status: agentJobs.status,
        agentId: agentJobs.agentId,
        result: agentJobs.result,
      })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, parentJobId));
  } finally {
    await close();
  }
}

/**
 * Delete memories for an entity (cleanup before tests).
 * Optionally filter by source.
 */
export async function cleanEntityMemories(
  entityId: string,
  opts: { source?: string } = {},
): Promise<void> {
  const { agentMemory, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    if (opts.source) {
      await db
        .delete(agentMemory)
        .where(and(eq(agentMemory.entityId, entityId), eq(agentMemory.source, opts.source)));
    } else {
      await db.delete(agentMemory).where(eq(agentMemory.entityId, entityId));
    }
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

  let betterAuthAvailable = false;
  try {
    const probe = await fetch(`${baseURL}/api/auth/get-session`, {
      headers: { Origin: baseURL },
      signal: AbortSignal.timeout(10_000),
    });
    betterAuthAvailable = probe.ok;
  } catch {
    betterAuthAvailable = false;
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

// ─── LM Studio + runner guards ────────────────────────────────────────────────

/** Base URL for the local LM Studio server. */
const LM_STUDIO_URL = 'http://localhost:1234';

/**
 * Probe LM Studio. Throws with a clear message if it is not responsive within
 * the given timeout.
 */
export async function requireLmStudio(timeoutMs = 10_000): Promise<void> {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(
        `LM_Studio_unresponsive — /v1/models returned ${res.status}. Restart LM Studio manually.`,
      );
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('LM_Studio_unresponsive')) throw err;
    throw new Error(`LM_Studio_unresponsive — ${msg}. Restart LM Studio manually.`);
  }
}

/**
 * Wait until no other job is in `processing` state. Prevents saturating the
 * runner/LM Studio with concurrent requests.
 */
export async function waitForNoProcessingJobs(timeoutMs = 60_000): Promise<void> {
  const { agentJobs, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await pollDb(
      async () => {
        const rows = await db
          .select({ id: agentJobs.id })
          .from(agentJobs)
          .where(eq(agentJobs.status, 'processing'));
        return rows.length === 0 ? true : null;
      },
      { timeoutMs, intervalMs: 3_000 },
    );
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
 */
export async function cleanCredentialsByType(type: CredentialType): Promise<void> {
  const { credentials, eq, and } = await import('@nodal-agents/db');
  const { userId } = await resolveActingUser();
  const { db, close } = makeDbClient();
  try {
    await db
      .delete(credentials)
      .where(and(eq(credentials.ownerUserId, userId), eq(credentials.type, type)));
  } finally {
    await close();
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

/**
 * Insert an agent job directly (for Scenario E — Telegram channel).
 */
export async function insertJob(opts: {
  entityId: string;
  agentId: string;
  task: string;
  channel: 'telegram' | 'api' | 'task-board' | 'internal' | 'cron';
}): Promise<string> {
  const { agentJobs } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: opts.entityId,
        agentId: opts.agentId,
        task: opts.task,
        channel: opts.channel,
        status: 'pending',
      })
      .returning({ id: agentJobs.id });
    return row!.id;
  } finally {
    await close();
  }
}

/**
 * Wake the runner for a pending job by posting to /api/worker with WORKER_SECRET.
 */
export async function triggerRunner(jobId: string): Promise<void> {
  const WORKER_SECRET = readWorkerSecret();
  const RUNNER_URL = 'http://localhost:3001';
  const res = await fetch(`${RUNNER_URL}/api/worker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`triggerRunner failed (${res.status}): ${body}`);
  }
}

/**
 * Insert a planner agent + assignment into the DB for scenario C.
 * Returns { plannerId }.
 * Idempotent by slug: if already exists, returns existing id.
 */
export async function ensurePlannerAgent(opts: {
  entityId: string;
  subAgentId: string;
  slug: string;
}): Promise<{ plannerId: string }> {
  const { agents, agentAssignments, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Stronger personality: gemma-4-31b doesn't reliably infer save_memory from
    // a soft instruction. Be explicit about the sequence (decompose → wait →
    // SAVE → return) so the test doesn't rely on the LLM's judgment.
    const personality = `Tu es un planner. Pour chaque tâche multi-étapes :

ÉTAPE 1. Décompose la tâche en sous-tâches via create_task. Une seule par appel.
ÉTAPE 2. Attends que les sous-tâches reviennent avec leur résultat.
ÉTAPE 3. **OBLIGATOIRE** : pour chaque résultat numérique, factuel, ou information utile reçu, appelle save_memory avec un payload (fact, category, importance) AVANT toute autre action. Ne saute jamais cette étape, même si le résultat te semble évident. Tu utilises category='outcome' pour les résultats de calculs, 'context' pour les facts, 'preference' pour les choix utilisateur.
ÉTAPE 4. UNIQUEMENT après avoir appelé save_memory pour chaque résultat important, appelle return_result avec un résumé.

Si tu sautes l'étape 3, ton travail est incomplet — c'est une violation directe de tes instructions.`;

    // Check if planner already exists; if so, UPDATE personality (so changes
    // take effect on re-runs without manual DB cleanup).
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, opts.slug))
      .limit(1);

    let plannerId: string;
    if (existing.length > 0) {
      plannerId = existing[0]!.id;
      await db.update(agents).set({ personality }).where(eq(agents.id, plannerId));
    } else {
      const [row] = await db
        .insert(agents)
        .values({
          entityId: opts.entityId,
          name: 'E2E Planner',
          slug: opts.slug,
          personality,
          model: 'google/gemma-4-31b',
          role: 'orchestrator',
          orchestratorMode: 'planner',
          active: true,
        })
        .returning({ id: agents.id });
      plannerId = row!.id;
    }

    // Ensure assignment exists
    const existingAssignment = await db
      .select({ id: agentAssignments.id })
      .from(agentAssignments)
      .where(eq(agentAssignments.orchestratorId, plannerId))
      .limit(1);

    if (existingAssignment.length === 0) {
      await db.insert(agentAssignments).values({
        orchestratorId: plannerId,
        subAgentId: opts.subAgentId,
        entityId: opts.entityId,
      });
    }

    return { plannerId };
  } finally {
    await close();
  }
}
