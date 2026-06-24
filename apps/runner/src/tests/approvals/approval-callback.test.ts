// approval-callback.test.ts — Telegram inline-button approval resolution.
//
// Focus: (1) the pure payload/summary helpers, and (2) the SECURITY boundary of
// the callback handler — a tap only resolves an approval when it comes from the
// same chat the card was sent to AND targets an approval owned by the polling
// agent. Resolution flips the real DB rows (approval → approved/rejected, job →
// pending), asserted directly.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs, agents } from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import {
  handleApprovalCallback,
  parseApprovalCallbackData,
} from '../../telegram/approval-callback.ts';
import { describeGatedAction, approvalCallbackData } from '../../approvals/notify.ts';

// Every Telegram API call (answerCallbackQuery/editMessageText) and the
// triggerWorker resume hit fetch — stub it to a generic ok so tests are hermetic.
vi.stubGlobal(
  'fetch',
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
);

const CHAT_ID = '199791464';

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  // The job must carry the chat_id the card was delivered to (the auth boundary),
  // and its agent must own a bot so the delivery-target resolver finds it (the
  // non-delegated case — the gated job's own agent is the bot owner).
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', chatId: CHAT_ID })
    .where(eq(agentJobs.id, seed.jobId));
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

async function insertPendingApproval(toolName = 'run_command'): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName,
      toolInput: { command: 'rm -rf /tmp/x' },
      status: 'pending',
    })
    .returning();
  return row!.id;
}

function callbackUpdate(data: string, chatId: number | string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      data,
      from: { id: 42, first_name: 'Q' },
      message: { message_id: 555, chat: { id: Number(chatId), type: 'private' } },
    },
  };
}

describe('parseApprovalCallbackData', () => {
  it('parses approve/reject and rejects foreign or malformed payloads', () => {
    const id = '00000000-0000-0000-0000-0000000000ab';
    expect(parseApprovalCallbackData(`apr:${id}:a`)).toEqual({
      approvalRequestId: id,
      decision: 'approve',
    });
    expect(parseApprovalCallbackData(`apr:${id}:r`)).toEqual({
      approvalRequestId: id,
      decision: 'reject',
    });
    expect(parseApprovalCallbackData(`other:${id}:a`)).toBeNull();
    expect(parseApprovalCallbackData(`apr:${id}:x`)).toBeNull();
    expect(parseApprovalCallbackData('apr:only-two')).toBeNull();
    expect(parseApprovalCallbackData(undefined)).toBeNull();
  });

  it('round-trips with approvalCallbackData', () => {
    const id = '00000000-0000-0000-0000-0000000000cd';
    expect(parseApprovalCallbackData(approvalCallbackData(id, 'a'))?.decision).toBe('approve');
    expect(parseApprovalCallbackData(approvalCallbackData(id, 'r'))?.decision).toBe('reject');
  });
});

describe('describeGatedAction', () => {
  it('summarizes known tools without leaking structure', () => {
    expect(describeGatedAction('run_command', { command: 'ls -la' })).toContain('ls -la');
    expect(
      describeGatedAction('skill_file_write', { skill: 'comfyui', path: 'workflows/z.json' }),
    ).toContain('comfyui → workflows/z.json');
    expect(describeGatedAction('mystery_tool', { a: 1 })).toContain('mystery_tool');
  });
});

describe('handleApprovalCallback — security boundary', () => {
  it('resolves when the tap is from the job chat and the owning agent', async () => {
    const id = await insertPendingApproval();
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(true);
    // The REAL rows flipped: approval approved, job back to pending.
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('approved');
    expect(ap!.resolvedBy).toBe('telegram');
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, seed.jobId)).limit(1);
    expect(job!.status).toBe('pending');
  });

  it('REJECTS a tap from a different chat — approval stays pending', async () => {
    const id = await insertPendingApproval();
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, '999000999'), // wrong chat
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('chat_mismatch');
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('pending'); // untouched
  });

  it('REJECTS a tap for an approval owned by a different agent', async () => {
    const id = await insertPendingApproval();
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID),
      receivingAgentId: '00000000-0000-0000-0000-0000000000ff', // not the owner
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('agent_mismatch');
  });

  it('reports already_resolved without re-resolving', async () => {
    const id = await insertPendingApproval();
    await db
      .update(approvalRequests)
      .set({ status: 'approved' })
      .where(eq(approvalRequests.id, id));
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:r`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('already_resolved');
  });
});
