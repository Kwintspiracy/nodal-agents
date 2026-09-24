/**
 * shell-checklist.spec.ts — what an agent may NOT do with a shell (#464).
 *
 * The Autonomy tab lists the kinds of action Nodal reads in a command, each
 * Allowed / Ask me / Never.
 *
 * What this journey proves, in a browser against the real database:
 *   - the tab is named Autonomy (#438: the guides always called it that);
 *   - a new agent shows "Ask me" on every row of the checklist;
 *   - a click on "Never" for deleting files is WRITTEN (the row read back from
 *     `agents.shell_policy`), and survives a reload;
 *   - the "Run commands" sentence says what really happens instead of
 *     "Commands ask for your approval by default".
 *
 * What the engine does with those states is proven in
 * packages/tools/src/tests/shell-checklist-gate.test.ts and, on a real job, in
 * apps/runner/src/tests/job/run-command-flow.test.ts.
 */

import { test, expect } from '@playwright/test';
import {
  requireLiveStack,
  makeDbClient,
  pollDb,
  resolveActingUser,
  testSlugSuffix,
} from './helpers.ts';

let agentId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { agents } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Shell Checklist ${testSlugSuffix()}`,
        slug: `e2e-shell-checklist-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
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

async function storedPolicy(): Promise<unknown> {
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ shellPolicy: agents.shellPolicy })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.shellPolicy ?? null;
  } finally {
    await close();
  }
}

test.describe('the shell checklist @cap:regler-autonomie/ecran', () => {
  test('a new agent asks for everything; "Never" for deleting is saved and read back', async ({
    page,
  }) => {
    await page.goto(`/agents/${agentId}/edit?tab=autonomy`);
    await expect(page.getByRole('tab', { name: 'Autonomy', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('What it may do with a shell')).toBeVisible();
    await expect(page.getByText('Commands ask for your approval by default.')).toHaveCount(0);
    for (const row of ['inline_code', 'delete_files', 'download']) {
      await expect(page.getByTestId(`shell-btn-${row}-ask`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }

    await page.getByTestId('shell-btn-delete_files-never').click();

    const saved = await pollDb(
      async () => {
        const p = (await storedPolicy()) as { delete_files?: string } | null;
        return p?.delete_files === 'never' ? p : null;
      },
      { timeoutMs: 15_000, intervalMs: 300 },
    );
    expect(saved).toEqual({ delete_files: 'never' });

    await page.reload();
    await expect(page.getByTestId('shell-btn-delete_files-never')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 20_000 },
    );
  });
});
