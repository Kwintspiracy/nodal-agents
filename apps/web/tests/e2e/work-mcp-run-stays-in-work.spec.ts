/**
 * work-mcp-run-stays-in-work.spec.ts — a run from the MCP folder opens in Work.
 *
 * Quentin, 24/09: in the Work sidebar, choosing an entry of the MCP folder
 * sent the sidebar to "Scheduled" — "mauvais et particulièrement irritant".
 * The entry opened `/jobs/<id>`, and `/jobs` belongs to Scheduled: the rail
 * reads its section from the address alone (sidebar-nav.ts). Runs listed in
 * Work now open at `/chat/runs/<id>`, the same page under Work's address.
 *
 * What this proves, in a browser against the real database: a run that came
 * in over MCP is listed in the MCP folder with that address, opens there as the
 * run page (its task is on screen), and the sidebar stays on Work.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, resolveActingUser, testSlugSuffix } from './helpers.ts';

let agentId = '';
let jobId = '';
const TASK = `Review the export from MCP ${testSlugSuffix()}`;

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { agents, agentJobs } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `MCP Run ${testSlugSuffix()}`,
        slug: `e2e-mcp-run-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId,
        channel: 'mcp',
        task: TASK,
        status: 'completed',
        result: 'Done.',
      })
      .returning({ id: agentJobs.id });
    jobId = job!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

test.describe('a run from the MCP folder opens in Work @cap:suivre-execution/ecran', () => {
  test('the entry opens the run under /chat/runs, and the sidebar stays on Work', async ({
    page,
  }) => {
    await page.goto('/chat');
    const panel = page.getByTestId('sidebar-panel');
    await expect(panel).toHaveAttribute('aria-label', 'Work', { timeout: 30_000 });
    // The MCP folder opens folded, as it did for Quentin.
    await panel.getByText('MCP', { exact: true }).click();
    const entry = panel.locator(`a[href="/chat/runs/${jobId}"]`);
    await expect(entry).toHaveCount(1, { timeout: 20_000 });

    await entry.click();

    await page.waitForURL(`**/chat/runs/${jobId}`);
    await expect(page.getByText(TASK).first()).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveAttribute('aria-label', 'Work');
  });
});
