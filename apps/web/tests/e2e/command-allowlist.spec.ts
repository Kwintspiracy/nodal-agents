/**
 * An owner names the commands an agent may start, reads them back, then removes the list.
 *
 * command-allowlist.spec.ts — the screen of `agents.command_allowlist` (issue
 * #131). The engine level of the same capability is proved by
 * `packages/tools/src/builtin/command-allowlist.test.ts`; until this journey
 * existed the list had no screen at all, and the only way to set one was a SQL
 * UPDATE by hand.
 *
 * WHAT THIS SCREEN LEVEL PROVES: that the owner of an agent can say which
 * programs it may start, save it, come back and READ THE SAME LIST, and that
 * clearing the field gives the agent back its unrestricted behaviour instead of
 * silently refusing everything. The two states that look alike in a text field
 * are checked against the database row, not only against the page.
 *
 * What it does NOT prove: that a command outside the list is actually refused
 * at runtime. That is the engine level, and it lives in the tools package.
 *
 * The agent is created by the test and deleted at the end, its slug carrying
 * this run's id (the marker convention of #118) so two runs sharing a database
 * never touch each other's rows.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped if not reachable.
 */

import { test, expect, type Page } from '@playwright/test';
import { requireLiveStack, makeDbClient, pollDb, testSlugSuffix, E2E_RUN_ID } from './helpers.ts';

const E2E_EMAIL = 'e2e-playwright@nodalai.local';

let entityId = '';
let agentId = '';

async function resolveEntity(): Promise<string> {
  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Auth-enabled e2e and plain local-trust boot both supported, same shape as
    // telegram-allowlist.spec.ts.
    for (const email of [E2E_EMAIL, 'local@nodalai.local']) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!u) continue;
      const [e] = await db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.userId, u.id))
        .limit(1);
      if (e) return e.id;
    }
    throw new Error('No entity found for e2e or local user');
  } finally {
    await close();
  }
}

/** The saved list, read from the row the action writes. */
async function readAllowlist(): Promise<string[] | null> {
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [row] = await db
      .select({ commandAllowlist: agents.commandAllowlist })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row?.commandAllowlist ?? null;
  } finally {
    await close();
  }
}

test.beforeAll(async () => {
  await requireLiveStack();
  entityId = await resolveEntity();

  const { agents } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Command Allowlist E2E',
        slug: `cmd-allow-${E2E_RUN_ID}-${testSlugSuffix()}`,
        personality: 'p',
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

test.describe.configure({ timeout: 90_000 });

async function openAutonomyTab(page: Page): Promise<void> {
  await page.goto(`/agents/${agentId}/edit?tab=autonomy`);
  await expect(page.getByText('Commands this agent may start')).toBeVisible({ timeout: 20_000 });
}

test('an owner names two commands, reads them back, then removes the list @cap:assigner-outils/ecran', async ({
  page,
}) => {
  await openAutonomyTab(page);

  // A new agent has no list: unrestricted, and the screen says so in words.
  await expect(page.getByTestId('command-allowlist-state')).toContainText(
    'No list: this agent may start any command',
  );

  const entries = page.getByTestId('command-allowlist-entries');
  await entries.fill('node\nnpx vitest');
  await page.getByTestId('command-allowlist-save').click();

  const saved = await pollDb(
    async () => {
      const list = await readAllowlist();
      return list && list.length === 2 ? list : null;
    },
    { timeoutMs: 15_000 },
  );
  expect(saved).toEqual(['node', 'npx vitest']);

  // Reload: the list comes back from the database, not from client state.
  await openAutonomyTab(page);
  await expect(page.getByTestId('command-allowlist-entries')).toHaveValue('node\nnpx vitest');
  await expect(page.getByTestId('command-allowlist-state')).toContainText(
    '2 entries: only these programs start',
  );

  // Clearing the field removes the list. It does NOT refuse every command:
  // that is the checkbox, and the difference is the whole point of the screen.
  await page.getByTestId('command-allowlist-entries').fill('');
  await page.getByTestId('command-allowlist-save').click();

  const cleared = await pollDb(
    async () => {
      const list = await readAllowlist();
      return list === null ? 'null' : null;
    },
    { timeoutMs: 15_000 },
  );
  expect(cleared).toBe('null');

  await openAutonomyTab(page);
  await expect(page.getByTestId('command-allowlist-state')).toContainText(
    'No list: this agent may start any command',
  );
  await expect(page.getByTestId('command-allowlist-entries')).toHaveValue('');
});

test('"Refuse every command" saves an empty list, which is not the same as no list', async ({
  page,
}) => {
  await openAutonomyTab(page);

  await page.getByTestId('command-allowlist-refuse-every').check();
  await page.getByTestId('command-allowlist-save').click();

  const empty = await pollDb(
    async () => {
      const list = await readAllowlist();
      return Array.isArray(list) && list.length === 0 ? 'empty' : null;
    },
    { timeoutMs: 15_000 },
  );
  expect(empty).toBe('empty');

  await openAutonomyTab(page);
  await expect(page.getByTestId('command-allowlist-state')).toContainText(
    'Empty list: every command is refused',
  );
});

test('a shell on the list is refused, and the reason is shown next to the field', async ({
  page,
}) => {
  await openAutonomyTab(page);

  // The previous test left "Refuse every command" on, which disables the field.
  await page.getByTestId('command-allowlist-refuse-every').uncheck();
  await page.getByTestId('command-allowlist-entries').fill('powershell');
  await page.getByTestId('command-allowlist-save').click();

  // The message comes from the action itself, never from a second copy of the
  // rule in the browser.
  await expect(page.getByTestId('command-allowlist-error')).toContainText(
    'A shell cannot be on the list',
  );
});
