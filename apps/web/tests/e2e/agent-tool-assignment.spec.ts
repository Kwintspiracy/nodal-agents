/**
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

import { test, expect } from '@playwright/test';
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

/** Insert a fake Google Drive connector + credential; return their IDs.
 *
 * Cleans up any existing google-drive connector AND any stub credentials this
 * spec may have left behind in prior runs (e.g. Playwright was killed before
 * `afterAll` ran). Previously we only deleted the connector — the credential
 * row stayed orphaned, which surfaced as a "Cannot decrypt" banner on
 * /credentials for the user the next time they opened the page.
 */
async function insertTestConnector(
  userId: string,
  entityId: string,
): Promise<{ connectorId: string; credentialId: string }> {
  const { credentials, connectors, agentConnectorAssignments, eq, and } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Remove any prior google-drive connector for this entity. Capture the
    // FK to the credential so we can drop it too (ON DELETE SET NULL otherwise
    // leaves the credentials row dangling).
    const existing = await db
      .select({ id: connectors.id, credentialId: connectors.credentialId })
      .from(connectors)
      .where(and(eq(connectors.entityId, entityId), eq(connectors.slug, 'google-drive')));
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
      .where(
        and(eq(credentials.ownerUserId, userId), eq(credentials.name, 'E2E Test Drive Credential')),
      );

    // Insert a stub credential (payload is fake — no real decryption needed for UI test)
    const [credRow] = await db
      .insert(credentials)
      .values({
        ownerUserId: userId,
        name: 'E2E Test Drive Credential',
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
        name: 'E2E Google Drive',
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

test.describe('Agent edit page — Tools & Connectors section @cap:assigner-outils', () => {
  test.describe.configure({ timeout: 30_000 });

  test('Scenario A — Tools & Connectors section renders with the test connector', async ({
    page,
  }) => {
    await page.goto(`/agents/${testAgentId}/edit`);
    // Wait for page content to fully load (server component)
    await page.waitForLoadState('networkidle');

    // The section heading — the & in JSX renders as literal & in DOM
    await expect(page.locator('label', { hasText: 'Tools' }).first()).toBeVisible();

    // The E2E connector appears in the list
    await expect(page.getByText('E2E Google Drive')).toBeVisible();
  });

  test('Scenario B — checking connector checkbox creates assignment row in DB', async ({
    page,
  }) => {
    await page.goto(`/agents/${testAgentId}/edit`);
    await page.waitForLoadState('networkidle');

    // Locate the connector container that holds "E2E Google Drive".
    // The structure: div.rounded-lg > div.flex > input[checkbox] + button > span(name)
    // Find the div that contains the text and get its first checkbox.
    const connectorLabel = page.getByText('E2E Google Drive');
    await expect(connectorLabel).toBeVisible({ timeout: 10_000 });

    // The checkbox is a sibling of the button that holds the label text.
    // Navigate up to the flex row, then find the checkbox.
    const connectorFlexRow = connectorLabel.locator('..').locator('..');
    const checkbox = connectorFlexRow.locator('input[type="checkbox"]').first();

    // Ensure starting state is unchecked (no prior assignment)
    const isChecked = await checkbox.isChecked({ timeout: 5_000 });
    if (isChecked) {
      await checkbox.click();
      await pollAssignment(testAgentId, testConnectorId, { expect: 'absent', timeoutMs: 8_000 });
    }

    // Check the connector
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    // The server action is debounced (~400 ms). Poll DB for the assignment.
    await pollAssignment(testAgentId, testConnectorId, { expect: 'present', timeoutMs: 8_000 });

    // Summary text updates to "all enabled" (enabledOperations=null)
    await expect(page.getByText('all enabled')).toBeVisible({ timeout: 5_000 });
  });

  test('Scenario C — unchecking connector removes assignment from DB', async ({ page }) => {
    await page.goto(`/agents/${testAgentId}/edit`);
    await page.waitForLoadState('networkidle');

    const connectorLabel = page.getByText('E2E Google Drive');
    await expect(connectorLabel).toBeVisible({ timeout: 10_000 });
    const connectorFlexRow = connectorLabel.locator('..').locator('..');
    const checkbox = connectorFlexRow.locator('input[type="checkbox"]').first();

    // Ensure it is checked first
    if (!(await checkbox.isChecked({ timeout: 5_000 }))) {
      await checkbox.click();
      await pollAssignment(testAgentId, testConnectorId, { expect: 'present', timeoutMs: 8_000 });
    }

    // Uncheck the connector
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    // DB row should be deleted
    await pollAssignment(testAgentId, testConnectorId, { expect: 'absent', timeoutMs: 8_000 });
  });

  test('Scenario D — Enable all button keeps enabledOperations=null in DB', async ({ page }) => {
    await page.goto(`/agents/${testAgentId}/edit`);
    await page.waitForLoadState('networkidle');

    const connectorLabel = page.getByText('E2E Google Drive');
    await expect(connectorLabel).toBeVisible({ timeout: 10_000 });
    const connectorFlexRow = connectorLabel.locator('..').locator('..');
    const checkbox = connectorFlexRow.locator('input[type="checkbox"]').first();

    // Assign the connector
    if (!(await checkbox.isChecked({ timeout: 5_000 }))) {
      await checkbox.click();
      await pollAssignment(testAgentId, testConnectorId, { expect: 'present', timeoutMs: 8_000 });
    }

    // Expand the connector to show the operation grid (click the expand button)
    const expandBtn = connectorFlexRow.locator('button').first();
    await expandBtn.click();

    // The "Enable all" button should be visible
    await expect(page.getByRole('button', { name: 'Enable all' })).toBeVisible();

    // Click "Enable all"
    await page.getByRole('button', { name: 'Enable all' }).click();

    // Wait for debounce to fire (~600ms)
    await page.waitForTimeout(800);

    // DB row should have enabledOperations=null (all enabled)
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
});
