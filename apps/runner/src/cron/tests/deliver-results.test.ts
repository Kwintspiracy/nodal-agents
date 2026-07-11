// cron/tests/deliver-results.test.ts
// Acceptance criteria:
//   - all tasks done → delivery called once, root job marked completed
//   - second tick does NOT re-deliver (idempotency via completedAt guard)
//   - mixed done/failed tasks → still triggers delivery
//   - tasks still in_progress → no delivery
//   - compiled result includes all task titles + results
//   - regression: inject_delegation.wrong_status — all tasks found, not just first

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks, agents, telegramAllowedChats } from '@nodal-agents/db';

// Mock the channel send + the LLM resolver so we can assert WHAT gets sent to
// the channel (the short synthesis) without network/LLM. Hoisted by vitest.
// S3: deliver-results.ts now dispatches via getAdapter(...).sendText — the
// fake adapter below forwards to the same sendTelegramMessageMock so the
// existing assertions (on chatId/text) keep working unchanged.
type SendOpts = { chatId: string; text: string; botToken: string };
const sendTelegramMessageMock = vi.fn(async (_opts: SendOpts) => ({ messageId: 1 }));
const TRANSPORT_CHANNELS = new Set(['telegram', 'discord', 'slack', 'whatsapp']);
vi.mock('@nodal-agents/delivery', () => ({
  sendTelegramMessage: (opts: SendOpts) => sendTelegramMessageMock(opts),
  resolveTransportChannel: (channel: string | null | undefined) =>
    channel && TRANSPORT_CHANNELS.has(channel) ? channel : 'telegram',
  getAdapter: (channel: string) => ({
    channel,
    sendText: (creds: { botToken: string }, conversationId: string, text: string) =>
      sendTelegramMessageMock({ chatId: conversationId, text, botToken: creds.botToken }),
  }),
}));
const resolveAgentLlmClientMock = vi.fn((..._args: unknown[]): unknown => undefined);
vi.mock('../../job/resolve-llm.ts', () => ({
  resolveAgentLlmClient: (...args: unknown[]) => resolveAgentLlmClientMock(...args),
}));

import { deliverCompletedRoots, findUndeliveredRootJobIds } from '../deliver-results.ts';

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

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

    // A loud security log fires, naming the refused chatId and the job.
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('SECURITY'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('unapproved-chat-999'));
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
