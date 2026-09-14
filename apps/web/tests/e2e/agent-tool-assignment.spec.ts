/**
 * An owner gives an agent a connector from the agent's edit page, and takes it back.
 *
 * agent-tool-assignment.spec.ts — e2e: Tools & Connectors section on agent edit page.
 *
 * Scenarios:
 *  A — The Tools & Connectors section is visible on the agent edit page.
 *  B — Checking the connector checkbox persists an assignment row to DB.
 *  C — Unchecking removes the assignment (debounce + "all unchecked → unassign").
 *  D — Expanding a connector and clicking "Enable all" keeps enabledOperations=null.
 *
 * Strategy:
 *  - Insert a test connector + credential directly into DB in beforeAll.
 *  - Use makeDbClient() to read back assignment rows after UI interactions.
 *  - Clean up connector (cascade-deletes credential + assignments) in afterAll.
 *
 * The test does NOT hardcode agent or entity IDs; instead it derives them from
 * the DB based on the e2e sentinel user email.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped automatically if not reachable.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { requireLiveStack, makeDbClient, pollDb, resolveActingUser } from './helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * L'utilisateur et l'espace au nom desquels le dashboard agit.
 *
 * Cette fonction cherchait `e2e-playwright@nodalai.local` en dur. Ce compte
 * n'existe QUE si la pile tourne en local-auth ; en local-trust — le mode par
 * défaut, et celui de la mesure nocturne — le seed pose `local@nodalai.local`,
 * et le parcours mourait sur « E2E user e2e-playwright@nodalai.local not found
 * in DB » sans qu'aucune fonctionnalité soit en cause.
 */
async function resolveE2eUserContext(): Promise<{ userId: string; entityId: string }> {
  return resolveActingUser();
}

/** The names this spec gives to the rows it creates — and the ONLY rows it is
 *  ever allowed to delete. */
const TEST_CONNECTOR_NAME = 'E2E Google Drive';
const TEST_CREDENTIAL_NAME = 'E2E Test Drive Credential';

/** Insert a fake Google Drive connector + credential; return their IDs.
 *
 * Cleans up any connector AND any stub credential this spec may have left
 * behind in prior runs (e.g. Playwright was killed before `afterAll` ran).
 * Previously we only deleted the connector — the credential row stayed
 * orphaned, which surfaced as a "Cannot decrypt" banner on /credentials for
 * the user the next time they opened the page.
 */
async function insertTestConnector(
  userId: string,
  entityId: string,
): Promise<{ connectorId: string; credentialId: string }> {
  const { credentials, connectors, agentConnectorAssignments, eq, and } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Remove the connector THIS SPEC left behind. Capture the FK to the
    // credential so we can drop it too (ON DELETE SET NULL otherwise leaves the
    // credentials row dangling).
    //
    // Scoped by NAME, not by slug. `slug = 'google-drive'` alone selected EVERY
    // Google Drive of the workspace, and since the acting user is now resolved
    // for local-trust too, that is the developer's own Google Drive connector,
    // its assignments and its credential — deleted by a `beforeAll`, on a
    // machine where nothing warned. The spec only ever needs to clear the stub
    // it named itself.
    const existing = await db
      .select({ id: connectors.id, credentialId: connectors.credentialId })
      .from(connectors)
      .where(and(eq(connectors.entityId, entityId), eq(connectors.name, TEST_CONNECTOR_NAME)));
    for (const row of existing) {
      await db
        .delete(agentConnectorAssignments)
        .where(eq(agentConnectorAssignments.connectorId, row.id));
      await db.delete(connectors).where(eq(connectors.id, row.id));
      if (row.credentialId) {
        await db.delete(credentials).where(eq(credentials.id, row.credentialId));
      }
    }
    // Belt + suspenders: nuke any leftover credential rows from earlier spec
    // versions that didn't drop the credential on cleanup. Scoped by
    // (ownerUserId + name) so we never touch the user's real credentials.
    await db
      .delete(credentials)
      .where(and(eq(credentials.ownerUserId, userId), eq(credentials.name, TEST_CREDENTIAL_NAME)));

    // Insert a stub credential (payload is fake — no real decryption needed for UI test)
    const [credRow] = await db
      .insert(credentials)
      .values({
        ownerUserId: userId,
        name: TEST_CREDENTIAL_NAME,
        type: 'google-oauth',
        payload: 'stub-encrypted-payload',
      })
      .returning({ id: credentials.id });
    if (!credRow) throw new Error('Failed to insert test credential');

    // Insert a Google Drive connector with the real slug (required for ADAPTER_REGISTRY lookup)
    const [connRow] = await db
      .insert(connectors)
      .values({
        entityId,
        name: TEST_CONNECTOR_NAME,
        slug: 'google-drive',
        authType: 'oauth2',
        active: true,
        credentialId: credRow.id,
      })
      .returning({ id: connectors.id });
    if (!connRow) throw new Error('Failed to insert test connector');

    return { connectorId: connRow.id, credentialId: credRow.id };
  } finally {
    await close();
  }
}

/** Delete the test connector (and its credential). Assignments cascade via FK. */
async function deleteTestConnector(connectorId: string): Promise<void> {
  const { connectors, credentials, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Fetch credentialId before deleting
    const rows = await db
      .select({ credentialId: connectors.credentialId })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    const credentialId = rows[0]?.credentialId ?? null;

    await db.delete(connectors).where(eq(connectors.id, connectorId));
    if (credentialId) {
      await db.delete(credentials).where(eq(credentials.id, credentialId));
    }
  } finally {
    await close();
  }
}

/** Find the first active agent for the given entity. */
async function findAgentId(entityId: string): Promise<string> {
  const { agents, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.entityId, entityId), eq(agents.active, true)))
      .limit(1);
    if (!rows[0]) throw new Error('No active agent found for entity');
    return rows[0].id;
  } finally {
    await close();
  }
}

/** Poll for an assignment row to appear (or disappear) in DB. */
async function pollAssignment(
  agentId: string,
  connectorId: string,
  opts: { expect: 'present' | 'absent'; timeoutMs?: number },
): Promise<void> {
  const { agentConnectorAssignments, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await pollDb(
      async () => {
        const rows = await db
          .select({ agentId: agentConnectorAssignments.agentId })
          .from(agentConnectorAssignments)
          .where(
            and(
              eq(agentConnectorAssignments.agentId, agentId),
              eq(agentConnectorAssignments.connectorId, connectorId),
            ),
          );
        const found = rows.length > 0;
        if (opts.expect === 'present') return found ? true : null;
        // expect absent
        return found ? null : true;
      },
      { timeoutMs: opts.timeoutMs ?? 10_000, intervalMs: 500 },
    );
  } finally {
    await close();
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let testConnectorId: string;
let testAgentId: string;

// Le second argument de `beforeAll`/`afterAll` est un TITRE, pas un budget de
// temps : le `15_000` passé ici n'a jamais rien allongé, et TypeScript le
// refusait (TS2345) sans que personne le voie — `tsconfig.json` exclut
// `tests/`. Retiré plutôt que corrigé : le budget par défaut suffit.
test.beforeAll(async () => {
  await requireLiveStack();
  const { userId, entityId } = await resolveE2eUserContext();
  const { connectorId } = await insertTestConnector(userId, entityId);
  testConnectorId = connectorId;
  testAgentId = await findAgentId(entityId);
});

test.afterAll(async () => {
  if (testConnectorId) {
    await deleteTestConnector(testConnectorId);
  }
});

// ─── Suite ────────────────────────────────────────────────────────────────────

/**
 * Attend que la liste blanche d'opérations de l'assignation satisfasse `pick`,
 * et rend ce que `pick` a retourné. Remplace le `waitForTimeout(800)` qui
 * pariait sur la durée du debounce (300 ms) plutôt que sur son effet.
 */
async function pollAssignmentOperations<T>(
  agentId: string,
  connectorId: string,
  pick: (ops: string[] | null) => T | null,
): Promise<T> {
  const { agentConnectorAssignments, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    return await pollDb(
      async () => {
        const rows = await db
          .select({ enabledOperations: agentConnectorAssignments.enabledOperations })
          .from(agentConnectorAssignments)
          .where(
            and(
              eq(agentConnectorAssignments.agentId, agentId),
              eq(agentConnectorAssignments.connectorId, connectorId),
            ),
          );
        if (rows.length !== 1) return null;
        return pick(rows[0]!.enabledOperations);
      },
      { timeoutMs: 10_000, intervalMs: 400 },
    );
  } finally {
    await close();
  }
}
/**
 * L'onglet Connecteurs de la page d'édition (`ConnectorsTabContent.tsx`).
 *
 * Ce parcours cherchait un `<label>Tools</label>` et une case à cocher par
 * connecteur — la forme de `AgentForm`. L'édition est passée à
 * `AgentComposer`, où les connecteurs vivent dans un onglet à part
 * (`?tab=connectors`) : une section « Connected · N », un bouton
 * « + Attach connectors » qui ouvre une modale listant la bibliothèque du
 * workspace, et par ligne deux boutons d'icône (« Attach », « Detach »)
 * au lieu d'une case. D'où l'erreur d'origine :
 * `locator('label').filter({ hasText: 'Tools' }).first()` → element(s) not
 * found, puis `getByText('E2E Google Drive')` → element(s) not found.
 */

/** La ligne `EdRow` qui porte ce nom, dans la page ou dans la modale. */
function edRow(scope: Page | Locator, name: string): Locator {
  return scope.locator('[class*="rounded-[10px]"]').filter({ hasText: name });
}

/** Ouvre l'onglet Connecteurs de l'agent de test. */
async function openConnectorsTab(page: Page): Promise<void> {
  await page.goto(`/agents/${testAgentId}/edit?tab=connectors`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: '+ Attach connectors' })).toBeVisible();
}

/** Attache le connecteur de test par le geste réel : la modale, puis « Attach ». */
async function attachTestConnector(page: Page): Promise<void> {
  await page.getByRole('button', { name: '+ Attach connectors' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await edRow(dialog, 'E2E Google Drive').getByRole('button', { name: 'Attach' }).click();
  await pollAssignment(testAgentId, testConnectorId, { expect: 'present', timeoutMs: 10_000 });
  // Deux boutons portent ce nom : la croix de l'en-tête et le bouton du pied
  // de modale. C'est le second que l'utilisateur vise.
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
}

/** Amène la page dans l'état « connecteur attaché », quel que soit l'état de départ. */
async function ensureAttached(page: Page): Promise<void> {
  await openConnectorsTab(page);
  if ((await edRow(page, 'E2E Google Drive').count()) === 0) {
    await attachTestConnector(page);
  }
  await expect(edRow(page, 'E2E Google Drive')).toBeVisible();
}

/** Détache le connecteur s'il l'est, pour que chaque cas parte du même état. */
async function detachIfAttached(page: Page): Promise<void> {
  await openConnectorsTab(page);
  const row = edRow(page, 'E2E Google Drive');
  if ((await row.count()) > 0) {
    await row.getByRole('button', { name: 'Detach' }).click();
    await pollAssignment(testAgentId, testConnectorId, { expect: 'absent', timeoutMs: 10_000 });
  }
}

test.describe('Agent edit page — Tools & Connectors section @cap:assigner-outils/ecran', () => {
  test.describe.configure({ timeout: 45_000 });

  test('Scenario A — Tools & Connectors section renders with the test connector', async ({
    page,
  }) => {
    await openConnectorsTab(page);

    // La section des connecteurs attachés, avec son compte.
    await expect(page.getByText(/^Connected · \d+$/)).toBeVisible();

    // Le connecteur de test est offert par la bibliothèque du workspace.
    await page.getByRole('button', { name: '+ Attach connectors' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('E2E Google Drive')).toBeVisible();
    await expect(
      edRow(dialog, 'E2E Google Drive').getByRole('button', { name: 'Attach' }),
    ).toBeVisible();
  });

  test('Scenario B — checking connector checkbox creates assignment row in DB', async ({
    page,
  }) => {
    await detachIfAttached(page);
    await attachTestConnector(page);

    // La ligne a rejoint « Connected », et l'assignation vaut « toutes les ops ».
    const row = edRow(page, 'E2E Google Drive');
    await expect(row).toBeVisible();
    await expect(row.getByText(/^all \d+ ops$/)).toBeVisible();

    const { agentConnectorAssignments, eq, and } = await import('@nodal-agents/db');
    const { db, close } = makeDbClient();
    try {
      const rows = await db
        .select({ enabledOperations: agentConnectorAssignments.enabledOperations })
        .from(agentConnectorAssignments)
        .where(
          and(
            eq(agentConnectorAssignments.agentId, testAgentId),
            eq(agentConnectorAssignments.connectorId, testConnectorId),
          ),
        );
      expect(rows.length).toBe(1);
      expect(rows[0]!.enabledOperations).toBeNull();
    } finally {
      await close();
    }
  });

  test('Scenario C — unchecking connector removes assignment from DB', async ({ page }) => {
    await ensureAttached(page);

    await edRow(page, 'E2E Google Drive').getByRole('button', { name: 'Detach' }).click();

    // La ligne quitte « Connected »…
    await expect(edRow(page, 'E2E Google Drive')).toHaveCount(0);
    // …et la ligne d'assignation disparaît de la base.
    await pollAssignment(testAgentId, testConnectorId, { expect: 'absent', timeoutMs: 10_000 });
  });

  test('Scenario D — Enable all button keeps enabledOperations=null in DB', async ({ page }) => {
    await ensureAttached(page);

    const row = edRow(page, 'E2E Google Drive');
    await row.getByRole('button', { name: 'Configure' }).click();

    // On retire une opération : la liste blanche cesse d'être « tout ».
    const firstOp = row.locator('input[type="checkbox"]').first();
    await expect(firstOp).toBeChecked();
    await firstOp.click();
    const narrowed = await pollAssignmentOperations(testAgentId, testConnectorId, (ops) =>
      Array.isArray(ops) ? ops : null,
    );
    expect(narrowed.length).toBeGreaterThan(0);

    // « Enable all » la ramène à null — « tout », pas « la liste complète ».
    await row.getByRole('button', { name: 'Enable all' }).click();
    await pollAssignmentOperations(testAgentId, testConnectorId, (ops) =>
      ops === null ? ([] as string[]) : null,
    );

    await expect(row.getByText(/^all \d+ ops$/)).toBeVisible();
  });
});
