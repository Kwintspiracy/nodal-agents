// notify.test.ts — deterministic, server-sent approval card.
//
// This is the fix for "AUCUN message Telegram on approval": the runner must send
// the card itself (not via an LLM nudge), with ✅/❌ inline buttons, whenever the
// job has a Telegram chat + the agent has a bot token — and stay silent otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agents, agentJobs } from '@nodal-agents/db';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../../deps.ts';
import { notifyApprovalCreated } from '../../approvals/notify.ts';

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string; llmKeyId: string };

const CHAT_ID = '199791464';
const fetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
vi.stubGlobal('fetch', fetchMock);

function req(): ApprovalGateRequest {
  return {
    approvalRequestId: '00000000-0000-0000-0000-0000000000ab',
    toolName: 'run_command',
    toolInput: { command: 'rm -rf /tmp/x' },
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

beforeEach(() => fetchMock.mockClear());

describe('notifyApprovalCreated', () => {
  it('sends a card with ✅/❌ buttons when the job has a chat and the agent a bot', async () => {
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: '123:fake' })
      .where(eq(agents.id, seed.agentId));

    await notifyApprovalCreated(deps, req());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    const body = JSON.parse(init.body as string) as {
      chat_id: string;
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.text).toContain('rm -rf /tmp/x'); // the gated action is shown
    const buttons = body.reply_markup.inline_keyboard[0]!;
    expect(buttons.map((b) => b.callback_data)).toEqual([
      'apr:00000000-0000-0000-0000-0000000000ab:a',
      'apr:00000000-0000-0000-0000-0000000000ab:r',
    ]);
  });

  it('renders purpose (line 1) + deterministic impact (line 2) + raw detail (line 3)', async () => {
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: '123:fake' })
      .where(eq(agents.id, seed.agentId));

    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000ac',
      toolName: 'run_command',
      toolInput: { command: 'rm -rf /tmp/x', purpose: 'Clean up the scratch dir before the run' },
      jobId: seed.jobId,
      agentId: seed.agentId,
      entityId: seed.entityId,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    const purposeIdx = body.text.indexOf('Clean up the scratch dir before the run');
    // Impact line is derived from the gate's own classifiers (approval-impact
    // enrichment, 2026-07-08): `rm -rf` is flagged destructive AND the actual
    // binary is named — no more generic "runs a shell command".
    const impactIdx = body.text.indexOf('destructive or heavy');
    const detailIdx = body.text.indexOf('rm -rf /tmp/x');
    expect(body.text).toContain('`rm`');
    // Line 1 (purpose) before line 2 (impact) before line 3 (raw detail).
    expect(purposeIdx).toBeGreaterThan(-1);
    expect(impactIdx).toBeGreaterThan(purposeIdx);
    expect(detailIdx).toBeGreaterThan(impactIdx);
  });

  it('falls back to an honest "not specified" line when the agent omits purpose — never invents one', async () => {
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: '123:fake' })
      .where(eq(agents.id, seed.agentId));

    await notifyApprovalCreated(deps, req()); // req() has no `purpose` field

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('Purpose not specified by the agent.');
  });

  it('stays silent (no send) when the job has no chat', async () => {
    await db.update(agentJobs).set({ chatId: null }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: '123:fake' })
      .where(eq(agents.id, seed.agentId));

    await notifyApprovalCreated(deps, req());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays silent when the agent has no bot token', async () => {
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));

    await notifyApprovalCreated(deps, req());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DELEGATION: gate in a bot-less sub-job delivers via the orchestrator bot', async () => {
    // The exact bug the user hit: a gated action fires inside a delegated job
    // (e.g. director) whose agent has NO bot. The card must still reach the user,
    // via the ORCHESTRATOR's bot (e.g. alfred), resolved by walking parent_job_id.
    // Orchestrator (root) — has the bot + owns the chat.
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: 'orch:bot' })
      .where(eq(agents.id, seed.agentId));

    // A bot-less delegate agent + its internal sub-job, parented to the root.
    const [delegate] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Delegate',
        slug: `delegate-${seed.jobId.slice(0, 8)}`,
        personality: 'sub-agent',
        llmKeyId: seed.llmKeyId,
        // no telegramBotToken
      })
      .returning();
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: delegate!.id,
        channel: 'internal',
        chatId: CHAT_ID,
        parentJobId: seed.jobId,
        task: 'generate image',
      })
      .returning();

    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000ef',
      toolName: 'run_command',
      toolInput: { command: 'python submit.py' },
      jobId: childJob!.id,
      agentId: delegate!.id,
      entityId: seed.entityId,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      chat_id: string;
      reply_markup: { inline_keyboard: { callback_data: string }[][] };
    };
    // Delivered to the user's chat, via the orchestrator bot (token 'orch:bot' in the URL).
    expect(body.chat_id).toBe(CHAT_ID);
    expect(url).toContain('orch:bot');
    expect(body.reply_markup.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
      'apr:00000000-0000-0000-0000-0000000000ef:a',
      'apr:00000000-0000-0000-0000-0000000000ef:r',
    ]);
  });
});
