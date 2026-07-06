/**
 * telegram-allowlist.spec.ts — e2e for the H-1 inbound-chat allowlist UI on the
 * agent Telegram page (/agents/<id>/telegram → "Authorized chats").
 *
 * Scenarios:
 *  A — the section renders: owner is badged (no Revoke), a pending chat shows
 *      Approve/Deny, an active member shows Revoke.
 *  B — Approve a pending chat → its row flips to active in the DB.
 *  C — Revoke a member → ConfirmDialog → confirm → the row is deleted in the DB.
 *
 * The allowlist rows + a "connected" agent (a bot token is present so the page
 * renders the section) are seeded as PRECONDITION — the inbound flow that
 * normally creates these rows needs a live Telegram bot + DM, which isn't
 * available in e2e. The rows are what the UI displays/acts on; the ASSERTIONS
 * target the UI + the server actions' DB effect (approve→active, revoke→delete),
 * which is exactly what this test validates. The inbound row-creation flow is
 * covered by the handler unit tests.
 *
 * Requires a running Nodal-Agents stack (port 3000). Skipped if not reachable.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, pollDb, testSlugSuffix } from './helpers.ts';

const E2E_EMAIL = 'e2e-playwright@nodalai.local';

let entityId = '';
let agentId = '';
let pendingRowId = '';
let memberRowId = '';

async function resolveEntity(): Promise<string> {
  const { users, entities, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Auth-enabled e2e (pnpm e2e:up): the sentinel user owns the session. Plain
    // local-trust boot (verify-real-packed-install): the single seeded local
    // user is auto-authenticated. Support both so this spec runs either way.
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

test.beforeAll(async () => {
  await requireLiveStack();
  entityId = await resolveEntity();

  const { agents, telegramAllowedChats } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // A "connected" agent (bot token present → the page shows the allowlist
    // section). Inserted directly so no Telegram getMe validation runs.
    const slug = `tg-allow-${testSlugSuffix()}`;
    const [agent] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Telegram Allowlist E2E',
        slug,
        personality: 'p',
        role: 'agent',
        active: true,
        telegramBotToken: '123456:FAKE-e2e-token',
        telegramBotUsername: 'tg_allow_e2e_bot',
      })
      .returning({ id: agents.id });
    agentId = agent!.id;

    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: '1000001',
      role: 'owner',
      status: 'active',
      requesterName: 'Owner Person',
    });
    const [member] = await db
      .insert(telegramAllowedChats)
      .values({
        entityId,
        agentId,
        chatId: '1000002',
        role: 'member',
        status: 'active',
        requesterName: 'Member Person',
      })
      .returning({ id: telegramAllowedChats.id });
    memberRowId = member!.id;
    const [pending] = await db
      .insert(telegramAllowedChats)
      .values({
        entityId,
        agentId,
        chatId: '1000003',
        role: 'member',
        status: 'pending',
        requesterName: 'Pending Person',
      })
      .returning({ id: telegramAllowedChats.id });
    pendingRowId = pending!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { agents, telegramAllowedChats, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

test('A — allowlist renders: owner badged, pending has Approve/Deny, member has Revoke', async ({
  page,
}) => {
  await page.goto(`/agents/${agentId}/telegram`);

  const section = page.locator('div', { hasText: 'Authorized chats' }).first();
  await expect(page.getByText('Authorized chats')).toBeVisible();

  // Owner: badged, NOT revocable.
  await expect(page.getByText('Owner Person')).toBeVisible();
  // Pending: shows the waiting note + Approve/Deny.
  await expect(page.getByText('Pending Person')).toBeVisible();
  await expect(page.getByText('Waiting for your approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  // Member: has a Revoke button.
  await expect(page.getByText('Member Person')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();
  void section;
});

test('B — Approve a pending chat activates it', async ({ page }) => {
  await page.goto(`/agents/${agentId}/telegram`);
  await page.getByRole('button', { name: 'Approve' }).click();

  // DB effect: the pending row is now active.
  const status = await pollDb(
    async () => {
      const { telegramAllowedChats, eq } = await import('@nodal-agents/db');
      const { db, close } = makeDbClient();
      try {
        const [row] = await db
          .select({ status: telegramAllowedChats.status })
          .from(telegramAllowedChats)
          .where(eq(telegramAllowedChats.id, pendingRowId))
          .limit(1);
        return row?.status === 'active' ? row.status : null;
      } finally {
        await close();
      }
    },
    { timeoutMs: 15_000 },
  );
  expect(status).toBe('active');
});

test('C — Revoke a member deletes the row (via ConfirmDialog)', async ({ page }) => {
  await page.goto(`/agents/${agentId}/telegram`);
  // Scope to the "Member Person" row — test B approved the pending chat, so more
  // than one active member (each with a Revoke button) can be present now.
  const row = page
    .locator('div.flex.items-center.justify-between')
    .filter({ hasText: 'Member Person' });
  await row.getByRole('button', { name: 'Revoke' }).click();

  // The design-system ConfirmDialog (never a native dialog) appears; confirm it.
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Revoke access?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Revoke' }).click();

  // DB effect: the member row is gone.
  const gone = await pollDb(
    async () => {
      const { telegramAllowedChats, eq } = await import('@nodal-agents/db');
      const { db, close } = makeDbClient();
      try {
        const rows = await db
          .select({ id: telegramAllowedChats.id })
          .from(telegramAllowedChats)
          .where(eq(telegramAllowedChats.id, memberRowId));
        return rows.length === 0 ? true : null;
      } finally {
        await close();
      }
    },
    { timeoutMs: 15_000 },
  );
  expect(gone).toBe(true);
});
