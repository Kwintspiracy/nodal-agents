/**
 * Activity is the list of runs: one row per run, unfolded into its calls.
 *
 * activity-runs.spec.ts — the screen of issue #134. Until this journey existed,
 * the Activity view listed one row per TOOL CALL: thirteen rows for a single
 * run, unreadable as soon as two agents worked at once. The engine level of the
 * same capability is proved by `apps/web/src/lib/__tests__/activity-runs-action.test.ts`
 * (grouping, interleaved time order, per-run pagination, and the fact that the
 * list loads no calls at all), each finding verified by mutation.
 *
 * WHAT THIS SCREEN LEVEL PROVES:
 *   - a run appears ONCE in Activity, with its agent and its call count;
 *   - unfolding that row shows the calls of that run, tool calls and model
 *     calls together, with the blocks the chat uses;
 *   - the Runs page has left the menu, and `/jobs` now lands on Activity while
 *     a single run keeps its own address.
 *
 * What it does NOT prove: that the counts and the order are right against the
 * database. A screen can be green in front of an unplugged engine, which is
 * why the two levels are separate.
 *
 * No model is involved: the run and its calls are seeded directly, as the other
 * database-driven specs do, so the journey runs on any stack including CI.
 * Every row created carries this run's id and is deleted in afterAll.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped if not reachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, resolveActingUser, testSlugSuffix } from './helpers.ts';

const suffix = testSlugSuffix();
const AGENT_NAME = `E2E Activity ${suffix}`;
const TOOL_NAME = `e2e_probe_${suffix.replace(/-/g, '_')}`;
const MODEL_NAME = `e2e-model-${suffix}`;
const TASK = `E2E activity run ${suffix}`;

let acting: { userId: string; entityId: string };
let agentId = '';
let jobId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  acting = await resolveActingUser();

  const { agents, agentJobs, toolCalls, llmCalls } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: AGENT_NAME,
        slug: `e2e-activity-${suffix}`,
        // NOT NULL with no default, and never read here: no model runs in this
        // journey. It is the row that matters, not what the agent would say.
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
        channel: 'api',
        task: TASK,
        status: 'completed',
        totalDurationMs: 4200,
        totalCostUsd: 0.0123,
      })
      .returning({ id: agentJobs.id });
    jobId = job!.id;

    const now = Date.now();
    await db.insert(llmCalls).values({
      entityId: acting.entityId,
      agentId,
      jobId,
      source: 'job',
      provider: 'openrouter',
      modelEffective: MODEL_NAME,
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.008,
      durationMs: 900,
      turn: 1,
      createdAt: new Date(now),
    });
    await db.insert(toolCalls).values({
      entityId: acting.entityId,
      jobId,
      toolName: TOOL_NAME,
      toolInput: { query: suffix },
      toolOutput: 'three articles found',
      durationMs: 320,
      turn: 1,
      createdAt: new Date(now + 1000),
    });
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  const { agents, agentJobs, toolCalls, llmCalls, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    if (jobId) {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobId));
      await db.delete(llmCalls).where(eq(llmCalls.jobId, jobId));
      await db.delete(agentJobs).where(eq(agentJobs.id, jobId));
    }
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

test('a run is one row, unfolded into its calls @cap:suivre-execution/ecran', async ({ page }) => {
  // The agent filter keeps the journey independent of whatever else the stack
  // has been doing: only this run is listed.
  await page.goto(`/logs?agent=${agentId}`);
  await page.waitForLoadState('networkidle', { timeout: 15_000 });

  const row = page.getByTestId(`run-row-${jobId}`);
  await expect(row, 'the run is missing from Activity').toBeVisible({ timeout: 10_000 });
  // ONE row for this run, not one per call.
  await expect(page.locator(`[data-testid="run-row-${jobId}"]`)).toHaveCount(1);
  await expect(row.getByTestId('run-agent')).toContainText(AGENT_NAME);
  // Two calls: one model call, one tool call, counted together.
  await expect(row.getByTestId('run-calls')).toContainText('2 calls');

  // Folded, the row shows no call at all: the block that carries them is not
  // in the page. (The tool name itself IS on the page, as an option of the
  // tool filter, which lists every tool this entity has ever called.)
  await expect(page.getByTestId(`run-calls-${jobId}`)).toHaveCount(0);

  await row.click();

  const unfolded = page.getByTestId(`run-calls-${jobId}`);
  await expect(unfolded).toBeVisible({ timeout: 10_000 });
  await expect(unfolded).toContainText(TOOL_NAME);
  await expect(unfolded).toContainText(MODEL_NAME);
  // The model call came first: the two tables are read as one line of time.
  const text = (await unfolded.innerText()).replace(/\s+/g, ' ');
  expect(text.indexOf(MODEL_NAME)).toBeLessThan(text.indexOf(TOOL_NAME));

  // The run keeps its own address, reached from the row.
  await expect(unfolded.getByRole('link', { name: /open run/i })).toHaveAttribute(
    'href',
    `/jobs/${jobId}`,
  );
});

test('the old Runs page has left the menu and /jobs lands on Activity @cap:suivre-execution/ecran', async ({
  page,
}) => {
  await page.goto('/logs');
  // WHAT LEFT THE MENU IS THE PAGE, NOT THE WORD. This used to look for a menu
  // link named "Runs", which worked only as long as nothing else carried that
  // word: the rail cell that opens this very list is named "Runs" since the
  // owner's board of 21/09/2026, and the name check then failed on the right
  // answer. The address is what the test means, so the address is what it now
  // reads: no menu entry points at the retired `/runs` page, whatever it is
  // called.
  await expect(
    page.locator('nav a[href^="/runs"]'),
    'a menu entry still points at the retired /runs page',
  ).toHaveCount(0);

  await page.goto('/jobs');
  await page.waitForURL(/\/logs(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

  // A single run still has its page, by its own address.
  const response = await page.goto(`/jobs/${jobId}`);
  expect(response?.status(), `/jobs/${jobId} HTTP status`).toBeLessThan(400);
  await expect(page.getByText(TASK).first()).toBeVisible({ timeout: 10_000 });
});
