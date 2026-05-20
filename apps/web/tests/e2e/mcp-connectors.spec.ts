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
import { requireLiveStack, makeDbClient, pollDb } from './helpers.ts';

const E2E_EMAIL = 'e2e-playwright@nodalai.local';

async function resolveE2eEntityId(): Promise<string> {
  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, E2E_EMAIL))
      .limit(1);
    const userId = userRows[0]?.id;
    if (!userId) throw new Error(`E2E user ${E2E_EMAIL} not found in DB`);
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.userId, userId))
      .limit(1);
    const entityId = entityRows[0]?.id;
    if (!entityId) throw new Error(`No entity found for e2e user ${E2E_EMAIL}`);
    return entityId;
  } finally {
    await close();
  }
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

test.beforeAll(async () => {
  await requireLiveStack();
  const entityId = await resolveE2eEntityId();
  testMcpServerId = await insertTestMcpServer(entityId);
  // Settle so the force-dynamic /mcp page reads the seeded row.
  await pollDb(async () => true, { timeoutMs: 1000, intervalMs: 200 });
}, 15_000);

test.afterAll(async () => {
  if (testMcpServerId) await deleteTestMcpServer(testMcpServerId);
}, 10_000);

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
