/**
 * mcp-connectors.spec.ts — e2e: the /mcp page and the MCP Connectors nav entry.
 *
 * Scenarios:
 *  A — /mcp renders a connected MCP server (seeded directly in DB).
 *  B — the sidebar shows "API Connectors" and "MCP Connectors", and the MCP
 *      link routes to /mcp.
 *
 * The actual "connect to a live MCP server" flow needs a real cog_ key + the
 * Cogni server, so it is covered by the manual live smoke, not here. This spec
 * seeds an mcp_servers row directly to exercise the rendered page.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped if not reachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, pollDb, resolveActingUser } from './helpers.ts';

/**
 * L'espace au nom duquel le dashboard agit — résolu par `resolveActingUser`,
 * qui demande son mode au serveur au lieu de supposer le compte sentinelle.
 * Cette fonction cherchait `e2e-playwright@nodalai.local` en dur : en
 * local-trust (le mode par défaut, celui de la mesure nocturne) ce compte
 * n'existe pas, et le parcours mourait sur « E2E user
 * e2e-playwright@nodalai.local not found in DB ».
 */
async function resolveE2eEntityId(): Promise<string> {
  const { entityId } = await resolveActingUser();
  return entityId;
}

/** Seed a connected mcp_servers row (no live connection needed). */
async function insertTestMcpServer(entityId: string): Promise<string> {
  const { mcpServers, eq, and } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Clean any leftover from a killed prior run.
    await db
      .delete(mcpServers)
      .where(and(eq(mcpServers.entityId, entityId), eq(mcpServers.slug, 'cogni-cortex')));
    const [row] = await db
      .insert(mcpServers)
      .values({
        entityId,
        name: 'Cogni Cortex',
        slug: 'cogni-cortex',
        transport: 'http',
        url: 'https://cogni-web-psi.vercel.app/api/mcp',
        apiKey: 'enc:v1:stub:stub:stub',
        apiKeyLast4: 'e2e1',
        authScheme: 'header',
        authParamName: 'x-api-key',
        availableTools: [
          { name: 'get_home', description: 'home' },
          { name: 'get_feed', description: null },
        ],
        active: true,
      })
      .returning({ id: mcpServers.id });
    if (!row) throw new Error('Failed to insert test mcp_servers row');
    return row.id;
  } finally {
    await close();
  }
}

async function deleteTestMcpServer(id: string): Promise<void> {
  const { mcpServers, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
  } finally {
    await close();
  }
}

let testMcpServerId: string;

// Le second argument de `beforeAll`/`afterAll` est un TITRE, pas un budget de
// temps : le `15_000` passé ici n'a jamais rien allongé, et TypeScript le
// refusait (TS2345) sans que personne le voie — `tsconfig.json` exclut
// `tests/`. Retiré plutôt que corrigé : le budget par défaut suffit.
test.beforeAll(async () => {
  await requireLiveStack();
  const entityId = await resolveE2eEntityId();
  testMcpServerId = await insertTestMcpServer(entityId);
  // Settle so the force-dynamic /mcp page reads the seeded row.
  await pollDb(async () => true, { timeoutMs: 1000, intervalMs: 200 });
});

test.afterAll(async () => {
  if (testMcpServerId) await deleteTestMcpServer(testMcpServerId);
});

test.describe('MCP Connectors page', () => {
  test.describe.configure({ timeout: 30_000 });

  test('Scenario A — /mcp renders the connected Cogni Cortex server', async ({ page }) => {
    await page.goto('/mcp');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'MCP Connectors' })).toBeVisible();
    await expect(page.getByText('Cogni Cortex').first()).toBeVisible();
    await expect(page.getByText('connected').first()).toBeVisible();
    await expect(page.getByText(/2 tools discovered/)).toBeVisible();
  });

  test('Scenario B — sidebar shows API Connectors and MCP Connectors', async ({ page }) => {
    await page.goto('/mcp');
    await page.waitForLoadState('networkidle');

    const apiLink = page.getByRole('link', { name: 'API Connectors' });
    const mcpLink = page.getByRole('link', { name: 'MCP Connectors' });
    await expect(apiLink).toBeVisible();
    await expect(mcpLink).toBeVisible();
    await expect(mcpLink).toHaveAttribute('href', '/mcp');
  });
});
