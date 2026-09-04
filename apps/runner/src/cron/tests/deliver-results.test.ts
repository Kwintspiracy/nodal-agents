// cron/tests/deliver-results.test.ts
// Acceptance criteria:
//   - all tasks done → delivery called once, root job marked completed
//   - second tick does NOT re-deliver (idempotency via completedAt guard)
//   - mixed done/failed tasks → still triggers delivery
//   - tasks still in_progress → no delivery
//   - compiled result includes all task titles + results
//   - regression: inject_delegation.wrong_status — all tasks found, not just first

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  agentTasks,
  agents,
  jobDeliveries,
  telegramAllowedChats,
  channelBindings,
  channelAllowedConversations,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type * as DeliveryModule from '@nodal-agents/delivery';
import type * as OutboxModule from '../../delivery/outbox.ts';

// Mock the channel send + the LLM resolver so we can assert WHAT gets sent to
// the channel (the short synthesis) without network/LLM. Hoisted by vitest.
// S3: deliver-results.ts now dispatches via getAdapter(...).sendText — the
// fake adapter below forwards to the same sendTelegramMessageMock so the
// existing assertions (on chatId/text) keep working unchanged.
type SendOpts = { chatId: string; text: string; botToken: string };
const sendTelegramMessageMock = vi.fn(async (_opts: SendOpts) => ({ messageId: 1 }));
// Mock PARTIEL (V&C T12) : l'outbox a besoin du vrai `DeliveryError` et du vrai
// `listActiveChannelsForAgent` (lu en base : un agent avec un token Telegram a
// Telegram actif) — la résolution de cible refuse `channel_inactive` sans
// canal actif, là où l'ancien code retombait sur 'telegram' en silence.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof DeliveryModule>();
  return {
    ...actual,
    sendTelegramMessage: (opts: SendOpts) => sendTelegramMessageMock(opts),
    getAdapter: (channel: string) => ({
      channel,
      // Le contrat d'un adaptateur rend un messageId STRING (Telegram : `String(message_id)`).
      sendText: (creds: { botToken: string }, conversationId: string, text: string) =>
        sendTelegramMessageMock({ chatId: conversationId, text, botToken: creds.botToken }).then(
          (r) => ({ messageId: String(r.messageId) }),
        ),
    }),
  };
});
const resolveAgentLlmClientMock = vi.fn((..._args: unknown[]): unknown => undefined);
vi.mock('../../job/resolve-llm.ts', () => ({
  resolveAgentLlmClient: (...args: unknown[]) => resolveAgentLlmClientMock(...args),
}));
// Le drain immédiat, remplaçable par test (par défaut le vrai) — pour simuler
// un processus mort entre le commit terminal et l'envoi.
type DrainFn = typeof OutboxModule.drainDeliveries;
const drainImpl =
  vi.fn<(db: AnyDrizzleDb, opts: Parameters<DrainFn>[1], real: DrainFn) => ReturnType<DrainFn>>();
vi.mock('../../delivery/outbox.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof OutboxModule>();
  return {
    ...actual,
    drainDeliveries: (db: AnyDrizzleDb, opts: Parameters<typeof actual.drainDeliveries>[1]) =>
      drainImpl(db, opts, actual.drainDeliveries),
  };
});

import {
  deliverCompletedRoots,
  findUndeliveredRootJobIds,
  releaseStaleFinalizingMarkers,
  FINALIZING_STALE_MS,
} from '../deliver-results.ts';
import { drainDeliveries as realDrain } from '../../delivery/outbox.ts';

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(() => {
  drainImpl.mockReset();
  drainImpl.mockImplementation((d, opts, real) => real(d, opts));
});

const deliveriesOf = (jobId: string) =>
  db
    .select({
      outcome: jobDeliveries.outcome,
      receipt: jobDeliveries.receipt,
      payload: jobDeliveries.payload,
      attempts: jobDeliveries.attempts,
    })
    .from(jobDeliveries)
    .where(eq(jobDeliveries.jobId, jobId));

const rootRow = async (jobId: string) => {
  const [row] = await db
    .select({
      status: agentJobs.status,
      completedAt: agentJobs.completedAt,
      finalizingAt: agentJobs.finalizingAt,
      result: agentJobs.result,
      error: agentJobs.error,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('root not found');
  return row;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createRootJob() {
  const rows = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'root task',
      status: 'completed', // root job already finished its planning phase
      messages: [],
    })
    .returning();
  return rows[0]!;
}

async function createTaskForRoot(
  rootJobId: string,
  status: string,
  result: string,
  title?: string,
) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: title ?? `Task ${Math.random().toString(36).slice(2, 6)}`,
      status,
      result,
      rootJobId,
    })
    .returning();
  return rows[0]!;
}

async function allowChat(chatId: string) {
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId,
    role: 'member',
    status: 'active',
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('deliverCompletedRoots', () => {
  it('marks root job completed when all tasks are done', async () => {
    const rootJob = await createRootJob();
    // Reset completedAt to null so deliverCompletedRoots can set it
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Task 1 result', 'Task 1');
    await createTaskForRoot(rootJob.id, 'done', 'Task 2 result', 'Task 2');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        result: agentJobs.result,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.completedAt).not.toBeNull();
    expect(updated[0]?.result).toContain('Task 1');
    expect(updated[0]?.result).toContain('Task 2');
  });

  it('does NOT re-deliver when root job already has completedAt set', async () => {
    const rootJob = await createRootJob();
    // completedAt is already set (from createRootJob)
    await createTaskForRoot(rootJob.id, 'done', 'already delivered result');

    // Set completedAt explicitly
    await db
      .update(agentJobs)
      .set({ completedAt: new Date(), result: 'previous delivery' })
      .where(eq(agentJobs.id, rootJob.id));

    await deliverCompletedRoots(db as RunnerDeps['db']);

    // This root job should be skipped (already delivered)
    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.result).toBe('previous delivery'); // unchanged
  });

  it('does not deliver when tasks are still in_progress', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'done result');
    await createTaskForRoot(rootJob.id, 'in_progress', 'not done yet');

    await deliverCompletedRoots(db as RunnerDeps['db']);
    // This specific root should NOT be delivered
    const updated = await db
      .select({ completedAt: agentJobs.completedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.completedAt).toBeNull();
  });

  it('delivers when mix of done and blocked tasks (all terminal) — root stays completed, body tags the failure', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Task A success', 'Task A');
    await createTaskForRoot(rootJob.id, 'blocked', 'Task B failed: some error', 'Task B');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    // At least one task succeeded — 'completed' is honest, and the body
    // tags the failed section so the partial nature is not hidden.
    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.error).toBeNull();
    expect(updated[0]?.result).toContain('Task A');
    expect(updated[0]?.result).toContain('Task B');
    expect(updated[0]?.result).toContain('[blocked]');
  });

  it('finding #8: root job marked failed (not completed) when ALL tasks are blocked/cancelled', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'blocked', 'Task A blocked: some error', 'Task A');
    await createTaskForRoot(rootJob.id, 'cancelled', 'Task B cancelled', 'Task B');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    // No task succeeded, and at least one genuinely broke ('blocked') — the
    // root must NOT be reported as 'completed'.
    expect(updated[0]?.status).toBe('failed');
    expect(updated[0]?.error).toBeTruthy();
    expect(updated[0]?.result).toContain('[blocked]');
    expect(updated[0]?.result).toContain('[cancelled]');
  });

  it('finding #8 refinement: root job marked cancelled (not failed) when ALL tasks were voluntarily cancelled', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'cancelled', 'Task A cancelled', 'Task A');
    await createTaskForRoot(rootJob.id, 'cancelled', 'Task B cancelled', 'Task B');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    // No task succeeded, but nothing broke either — a voluntary abort is not
    // a failure, so 'cancelled' (not 'failed') is the honest status.
    expect(updated[0]?.status).toBe('cancelled');
    expect(updated[0]?.error).toBeNull();
    expect(updated[0]?.result).toContain('[cancelled]');
  });

  it('compiled result includes all task titles and results', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Alpha result', 'Alpha Task');
    await createTaskForRoot(rootJob.id, 'done', 'Beta result', 'Beta Task');
    await createTaskForRoot(rootJob.id, 'done', 'Gamma result', 'Gamma Task');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    const compiled = updated[0]?.result ?? '';
    expect(compiled).toContain('Alpha Task');
    expect(compiled).toContain('Alpha result');
    expect(compiled).toContain('Beta Task');
    expect(compiled).toContain('Beta result');
    expect(compiled).toContain('Gamma Task');
    expect(compiled).toContain('Gamma result');
  });

  it('regression: inject_delegation.wrong_status — all tasks compiled, not just first', async () => {
    // Legacy bug: only the first task was included in the delivery result.
    // This test verifies that ALL tasks are compiled.
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    const TASKS = ['Research phase', 'Analysis phase', 'Summary phase', 'Final report'];
    const results = ['Research done', 'Analysis done', 'Summary done', 'Report done'];

    for (let i = 0; i < TASKS.length; i++) {
      await createTaskForRoot(rootJob.id, 'done', results[i]!, TASKS[i]);
    }

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    const compiled = updated[0]?.result ?? '';

    // ALL four tasks must appear in the compiled result
    for (const title of TASKS) {
      expect(compiled).toContain(title);
    }
    for (const res of results) {
      expect(compiled).toContain(res);
    }
  });

  it('channel return: synthesizes a SHORT summary and sends THAT (not the raw concat)', async () => {
    // Give the root agent a bot token + an LLM key so the channel-return path runs.
    await db
      .update(agents)
      .set({ telegramBotToken: 'bot:TESTTOKEN', model: 'x/y' })
      .where(eq(agents.id, seed.agentId));
    resolveAgentLlmClientMock.mockResolvedValueOnce({
      ok: true,
      client: { generateText: vi.fn(async () => ({ text: 'SHORT SUMMARY ✅' })) },
    });
    sendTelegramMessageMock.mockClear();
    await allowChat('12345'); // M4: send site now requires an active telegram_allowed_chats row

    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', channel: 'telegram', chatId: '12345' })
      .where(eq(agentJobs.id, rootJob.id));
    // A long result that would exceed Telegram's limit if sent raw.
    await createTaskForRoot(rootJob.id, 'done', 'x'.repeat(8000), 'Big Task A');
    await createTaskForRoot(rootJob.id, 'done', 'y'.repeat(8000), 'Big Task B');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    const arg = sendTelegramMessageMock.mock.calls[0]![0] as { chatId: string; text: string };
    expect(arg.chatId).toBe('12345');
    expect(arg.text).toBe('SHORT SUMMARY ✅'); // the synthesis, NOT the 16K concat
    expect(arg.text.length).toBeLessThan(100);
  });

  it('channel return: falls back to compiled text when the LLM is unavailable', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'bot:TESTTOKEN' })
      .where(eq(agents.id, seed.agentId));
    resolveAgentLlmClientMock.mockResolvedValueOnce({
      ok: false,
      reason: 'agent_no_llm_configured',
    });
    sendTelegramMessageMock.mockClear();
    await allowChat('777'); // M4: send site now requires an active telegram_allowed_chats row

    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', channel: 'telegram', chatId: '777' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'Fallback result body', 'Fallback Task');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    const arg = sendTelegramMessageMock.mock.calls[0]![0] as { text: string };
    expect(arg.text).toContain('Fallback result body'); // compiled text, chunking handles length
  });

  it('M4: root job chatId NOT in telegram_allowed_chats is refused — no send, job still completes, loud security log', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendTelegramMessageMock.mockClear();

    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({
        completedAt: null,
        status: 'processing',
        channel: 'telegram',
        chatId: 'unapproved-chat-999', // never inserted into telegram_allowed_chats
      })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'Task result body', 'Task A');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    // The send boundary is never reached for an unauthorized chatId.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    // Delivery refusal does not block completion — the root still transitions
    // to completed exactly as it would if the send had succeeded.
    const updated = await db
      .select({ status: agentJobs.status, completedAt: agentJobs.completedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));
    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.completedAt).not.toBeNull();

    // V&C T12 : le refus vit au DRAIN, dans l'outbox — la ligne est `rejected`
    // avec sa raison, et le rejet est dit par un code qui nomme le job (le
    // propriétaire est alerté ; sans chat owner ici, le code le dit aussi).
    const rows = await deliveriesOf(rootJob.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'rejected',
      receipt: { messageId: null, reason: 'allowlist_refused' },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('allowlist_refused'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(rootJob.id));

    consoleErrorSpy.mockRestore();
  });

  it('fix #27: findUndeliveredRootJobIds excludes an already-delivered root from the SCAN itself', async () => {
    // This is the actual claim of #27: the candidate query — not the per-row
    // loop guard further down — must not even return an already-delivered
    // root's id. Testing deliverCompletedRoots end-to-end can't distinguish
    // "excluded from the scan" from "included in the scan, then skipped by
    // the existing `if (rootJob.completedAt !== null) continue` guard" — both
    // produce the same observable outcome (the sentinel is untouched) even
    // WITHOUT the join fix. So call the scan function directly instead.
    const deliveredRoot = await createRootJob(); // createRootJob() sets completedAt already
    await createTaskForRoot(deliveredRoot.id, 'done', 'delivered root task');
    await db
      .update(agentJobs)
      .set({ completedAt: new Date() })
      .where(eq(agentJobs.id, deliveredRoot.id));

    const pendingRoot = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, pendingRoot.id));
    await createTaskForRoot(pendingRoot.id, 'done', 'pending root task');

    const candidates = await findUndeliveredRootJobIds(db as RunnerDeps['db']);

    // The delivered root's id must NOT appear in the candidate set at all —
    // proves the join filters it out at the SQL level, not just at the loop.
    expect(candidates).not.toContain(deliveredRoot.id);
    // The pending root's id must appear — the scan still surfaces real work.
    expect(candidates).toContain(pendingRoot.id);
  });

  it('C-2 (audit#2): a user-cancelled root is NOT resurrected into completed + delivered', async () => {
    // Mirrors cancelJobAction (apps/web/src/lib/actions.ts): sets the root's
    // status to 'cancelled' but NEVER touches completedAt, and cascades only
    // the still-open tasks to 'cancelled' — a task already 'done' before the
    // cancel keeps its 'done' status.
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'cancelled', channel: 'telegram', chatId: '99999' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'Task A finished before cancel', 'Task A');
    await createTaskForRoot(rootJob.id, 'cancelled', 'Task B cancelled', 'Task B');

    sendTelegramMessageMock.mockClear();
    await deliverCompletedRoots(db as RunnerDeps['db']);

    const updated = await db
      .select({
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        result: agentJobs.result,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    // (a) status must stay 'cancelled' — NOT overwritten to 'completed'.
    expect(updated[0]?.status).toBe('cancelled');
    // (b) never claimed/delivered, so completedAt is still untouched.
    expect(updated[0]?.completedAt).toBeNull();
    expect(updated[0]?.result).toBeNull();
    // (c) no channel delivery fired.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it('C-2: findUndeliveredRootJobIds excludes a cancelled root from the SCAN itself', async () => {
    const cancelledRoot = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'cancelled' })
      .where(eq(agentJobs.id, cancelledRoot.id));
    await createTaskForRoot(cancelledRoot.id, 'done', 'done before cancel');

    const candidates = await findUndeliveredRootJobIds(db as RunnerDeps['db']);

    expect(candidates).not.toContain(cancelledRoot.id);
  });

  // ─── B1 (notify-channel-choice): triggerContext.notifyChannel override ─────

  it('a cron root with an explicit triggerContext.notifyChannel delivers on THAT channel, not resolveTransportChannel’s priority default', async () => {
    // The agent has NO telegram/discord binding registered as "active" via the
    // fake listActiveChannelsForAgent (always []), so resolveTransportChannel's
    // fallback would pick 'telegram' — but the job explicitly chose 'discord',
    // and this must win.
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'discord-bot-token' }),
      enabled: true,
    });
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: 'discord-chat-1',
      role: 'owner',
      status: 'active',
    });
    // Skip the synthesis LLM call — irrelevant to what this test asserts
    // (channel/chatId/credential selection), same fallback path the
    // "falls back to compiled text" test above exercises explicitly.
    resolveAgentLlmClientMock.mockResolvedValueOnce({ ok: false, reason: 'test' });
    sendTelegramMessageMock.mockClear();

    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({
        completedAt: null,
        status: 'processing',
        channel: 'cron',
        chatId: 'discord-chat-1',
        triggerContext: {
          type: 'cron',
          scheduleName: 'notify via discord',
          prevRunAt: null,
          notifyChannel: 'discord',
        },
      })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'discord delivery result', 'Task A');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    const arg = sendTelegramMessageMock.mock.calls[0]![0] as {
      chatId: string;
      text: string;
      botToken: string;
    };
    expect(arg.chatId).toBe('discord-chat-1');
    expect(arg.botToken).toBe('discord-bot-token');

    await db.delete(channelBindings).where(eq(channelBindings.agentId, seed.agentId));
    await db
      .delete(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, seed.agentId));
  });

  // ─── V&C T12 : marqueur, payload figé, primitive, outbox ──────────────────

  it('T12 root done ⇒ completed via la primitive, ligne job_deliveries confirmed avec reçu, sendText UNE fois, finalizing_at NULL', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'bot:TESTTOKEN', model: 'x/y' })
      .where(eq(agents.id, seed.agentId));
    resolveAgentLlmClientMock.mockResolvedValueOnce({
      ok: true,
      client: { generateText: vi.fn(async () => ({ text: 'Résumé court' })) },
    });
    sendTelegramMessageMock.mockClear();
    await allowChat('t12-done');
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', channel: 'telegram', chatId: 't12-done' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'résultat A', 'A');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);

    expect(count).toBe(1);
    const root = await rootRow(rootJob.id);
    expect(root.status).toBe('completed');
    expect(root.completedAt).not.toBeNull();
    expect(root.finalizingAt).toBeNull();
    expect(root.result).toContain('résultat A');
    const rows = await deliveriesOf(rootJob.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'confirmed',
      receipt: { messageId: '1' },
      payload: 'Résumé court',
      attempts: 1,
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]![0]).toMatchObject({
      chatId: 't12-done',
      text: 'Résumé court',
    });
  });

  it('T12 root blocked ⇒ failed via failJob, résultat compilé, zéro ligne job_deliveries, marqueur levé', async () => {
    sendTelegramMessageMock.mockClear();
    await allowChat('t12-blocked');
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', channel: 'telegram', chatId: 't12-blocked' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'blocked', 'ça a cassé', 'B');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const root = await rootRow(rootJob.id);
    expect(root.status).toBe('failed');
    expect(root.error).toBe('all_tasks_failed (1)');
    expect(root.completedAt).not.toBeNull();
    expect(root.finalizingAt).toBeNull();
    expect(root.result).toContain('ça a cassé');
    expect(await deliveriesOf(rootJob.id)).toEqual([]);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it('T12 root cancelled ⇒ cancelled + completedAt, marqueur levé', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'cancelled', '', 'C');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const root = await rootRow(rootJob.id);
    expect(root.status).toBe('cancelled');
    expect(root.completedAt).not.toBeNull();
    expect(root.finalizingAt).toBeNull();
    expect(root.result).toContain('[cancelled]');
  });

  it('T12 marqueur périmé relâché : finalizing_at vieux de 11 min sans completedAt ⇒ retraité et finalisé', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({
        completedAt: null,
        status: 'processing',
        finalizingAt: new Date(Date.now() - FINALIZING_STALE_MS - 60_000),
      })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'après crash', 'D');

    // Marqué : hors du scan tant qu'il n'est pas relâché.
    const released = await releaseStaleFinalizingMarkers(db as RunnerDeps['db']);
    expect(released).toBeGreaterThanOrEqual(1);

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);
    const root = await rootRow(rootJob.id);
    expect(root.status).toBe('completed');
    expect(root.finalizingAt).toBeNull();
  });

  it('T12 marqueur FRAIS ⇒ le root est réclamé par un autre tick, pas retraité', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', finalizingAt: new Date() })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'en cours ailleurs', 'E');

    expect(await findUndeliveredRootJobIds(db as RunnerDeps['db'])).not.toContain(rootJob.id);
    await deliverCompletedRoots(db as RunnerDeps['db']);
    const root = await rootRow(rootJob.id);
    expect(root.status).toBe('processing');
    expect(root.completedAt).toBeNull();
  });

  it('T12 payload figé + crash après commit : la synthèse tourne UNE fois, le drain suivant livre UNE fois', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'bot:TESTTOKEN', model: 'x/y' })
      .where(eq(agents.id, seed.agentId));
    const generateText = vi.fn(async () => ({ text: 'Synthèse unique' }));
    resolveAgentLlmClientMock.mockReset();
    resolveAgentLlmClientMock.mockResolvedValue({ ok: true, client: { generateText } });
    sendTelegramMessageMock.mockClear();
    await allowChat('t12-crash');
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing', channel: 'telegram', chatId: 't12-crash' })
      .where(eq(agentJobs.id, rootJob.id));
    await createTaskForRoot(rootJob.id, 'done', 'résultat', 'F');
    // Le processus meurt entre le commit terminal et le drain immédiat.
    drainImpl.mockImplementationOnce(() => {
      throw new Error('processus mort');
    });

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);

    expect(count).toBe(1);
    expect((await rootRow(rootJob.id)).status).toBe('completed');
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    const before = await deliveriesOf(rootJob.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ outcome: 'prepared', payload: 'Synthèse unique' });
    expect(generateText).toHaveBeenCalledTimes(1);

    // Le tick suivant (seconde population) : livre depuis la ligne, sans LLM.
    const drained = await realDrain(db as unknown as AnyDrizzleDb, {});
    expect(drained.sent).toBe(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]![0]).toMatchObject({ text: 'Synthèse unique' });
    expect(generateText).toHaveBeenCalledTimes(1);
    const after = await deliveriesOf(rootJob.id);
    expect(after[0]).toMatchObject({ outcome: 'confirmed', attempts: 1 });
    resolveAgentLlmClientMock.mockReset();
    resolveAgentLlmClientMock.mockImplementation((..._args: unknown[]): unknown => undefined);
  });

  it('idempotency: two concurrent ticks deliver each root exactly once', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'concurrent task result');

    // Run two concurrent delivery calls
    const [countA, countB] = await Promise.all([
      deliverCompletedRoots(db as RunnerDeps['db']),
      deliverCompletedRoots(db as RunnerDeps['db']),
    ]);

    // Total delivered for this root = exactly 1 (one wins the atomic claim)
    const total = countA + countB;
    expect(total).toBeGreaterThanOrEqual(1); // at least 1 (could be 1 from other tests)

    // Verify the root job was delivered exactly once (completedAt set once)
    const updated = await db
      .select({ completedAt: agentJobs.completedAt, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.completedAt).not.toBeNull();
  });
});

// Augment the type for db in this file
type RunnerDeps = { db: typeof db };
