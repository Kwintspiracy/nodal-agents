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
import {
  and,
  approvalRequests,
  approvalRules,
  agentJobs,
  agents,
  telegramAllowedChats,
} from '@nodal-agents/db';
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

// CHAT_ID doubles as the bot OWNER's private chat throughout this suite — the
// non-delegated, non-guest case where the job's own chat IS the owner chat.
// GUEST_CHAT_ID is a distinct chat used by the invitee/self-approval tests
// below, where the job's originating chat must NOT be where the card lands.
const CHAT_ID = '199791464';
const GUEST_CHAT_ID = '555000111';

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string; llmKeyId: string };

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
  // The bot OWNER of record — resolveApprovalDeliveryTarget resolves the card's
  // chat from THIS row, never from agent_jobs.chat_id directly.
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

async function insertPendingApproval(
  toolName = 'run_command',
  jobId = seed.jobId,
): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName,
      toolInput: { command: 'rm -rf /tmp/x' },
      status: 'pending',
    })
    .returning();
  return row!.id;
}

function callbackUpdate(
  data: string,
  chatId: number | string,
  chatType: string = 'private',
): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      data,
      from: { id: 42, first_name: 'Q' },
      message: { message_id: 555, chat: { id: Number(chatId), type: chatType } },
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

  it('parse les trois suffixes du flux « Toujours autoriser »', () => {
    const id = '00000000-0000-0000-0000-0000000000ef';
    expect(parseApprovalCallbackData(`apr:${id}:w`)?.decision).toBe('always_ask');
    expect(parseApprovalCallbackData(`apr:${id}:wc`)?.decision).toBe('always_confirm');
    expect(parseApprovalCallbackData(`apr:${id}:wb`)?.decision).toBe('always_back');
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

  it('REJECTS a tap from a group chat — DM only (approval stays pending)', async () => {
    const id = await insertPendingApproval();
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID, 'group'),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('not_private_chat');
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('pending'); // untouched
  });

  it('REJECTS a tap from a supergroup chat — DM only (approval stays pending)', async () => {
    const id = await insertPendingApproval();
    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID, 'supergroup'),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });
    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('not_private_chat');
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('pending'); // untouched
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

describe('handleApprovalCallback — approval card routes to the bot OWNER, never the guest', () => {
  // A `member` chat (an authorized non-owner, H-1) triggers a gated action.
  // The card must land in the OWNER's chat (CHAT_ID, seeded in beforeAll above)
  // — never GUEST_CHAT_ID — so the member cannot self-approve by tapping from
  // their own conversation.
  async function insertGuestJob(): Promise<string> {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'guest-triggered gated action',
        chatId: GUEST_CHAT_ID,
        status: 'awaiting_approval',
      })
      .returning();
    return job!.id;
  }

  it('REJECTS a tap from the guest chat that triggered its own action (self-approval)', async () => {
    const guestJobId = await insertGuestJob();
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: GUEST_CHAT_ID,
      role: 'member',
      status: 'active',
    });
    const id = await insertPendingApproval('run_command', guestJobId);

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, GUEST_CHAT_ID), // the guest taps from their OWN chat
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('chat_mismatch'); // the card's chat is the owner's, not the guest's
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('pending'); // untouched — NOT self-approved
  });

  it('RESOLVES a tap from the OWNER chat for a job the guest triggered', async () => {
    const guestJobId = await insertGuestJob();
    const id = await insertPendingApproval('run_command', guestJobId);

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, CHAT_ID), // the owner taps from their own private chat
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(true);
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('approved');
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, guestJobId)).limit(1);
    expect(job!.status).toBe('pending'); // resumed
  });

  it('no owner on record → no_delivery_target, approval stays pending', async () => {
    // A distinct bot with a token but NO owner row — the defensive branch of
    // resolveApprovalDeliveryTarget (should not occur in practice per H-1, but
    // must fail loud rather than fall back to the guest's chat).
    const [ownerlessAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Ownerless Bot',
        slug: `ownerless-bot-${Date.now()}`,
        personality: 'test agent',
        llmKeyId: seed.llmKeyId,
        telegramBotToken: 'ownerless:fake',
      })
      .returning();
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: ownerlessAgent!.id,
        channel: 'telegram',
        task: 'ownerless gated action',
        chatId: GUEST_CHAT_ID,
        status: 'awaiting_approval',
      })
      .returning();
    const id = await insertPendingApproval('run_command', job!.id);

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:a`, GUEST_CHAT_ID),
      receivingAgentId: ownerlessAgent!.id,
      botToken: 'ownerless:fake',
      deps,
      env,
    });

    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('no_delivery_target');
    const [ap] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    expect(ap!.status).toBe('pending'); // untouched
  });
});

// ─── Le flux « Toujours autoriser » (lot approbations, 24/08) ────────────────
// Trois contrats : (1) le 1er tap N'APPROUVE RIEN — il édite la carte en
// question de confirmation ; (2) la confirmation écrit une VRAIE ligne
// approval_rules (asserted en base) AVANT d'approuver ; (3) « Back » restaure
// la carte d'origine, boutons compris, sans rien résoudre.

/** Les corps des appels editMessageText émis depuis le dernier mockClear. */
function editMessageBodies(): Array<{
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}> {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, { body?: string } | undefined]
  >;
  return calls
    .filter(([url]) => String(url).includes('editMessageText'))
    .map(([, init]) => JSON.parse(init?.body ?? '{}'));
}

describe('handleApprovalCallback — Toujours autoriser', () => {
  it('1er tap (w) : question de confirmation affichée, approbation INTACTE', async () => {
    const id = await insertPendingApproval();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:w`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(true);
    if (!r.handled) throw new Error('unreachable');
    expect(r.decision).toBe('always_confirm_shown');

    // Rien n'est résolu, aucune règle n'existe encore.
    const [ap] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(ap!.status, 'le 1er tap a résolu au lieu de demander confirmation').toBe('pending');

    // La carte a été éditée en question, avec les DEUX boutons wc/wb.
    const edits = editMessageBodies();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('Always allow run_command');
    const buttons = edits[0]!.reply_markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([`apr:${id}:wc`, `apr:${id}:wb`]);
  });

  it('confirmation (wc) : la règle auto_approve EXISTE en base, puis l’approbation est résolue', async () => {
    const id = await insertPendingApproval('run_skill_script');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:wc`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(true);
    if (!r.handled) throw new Error('unreachable');
    expect(r.decision).toBe('approve');

    // LA ligne qui compte : la règle permanente, en base, agent-scopée.
    const [rule] = await db
      .select()
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, seed.entityId),
          eq(approvalRules.agentId, seed.agentId),
          eq(approvalRules.toolName, 'run_skill_script'),
        ),
      );
    expect(rule, 'aucune règle auto_approve écrite').toBeDefined();
    expect(rule!.action).toBe('auto_approve');

    const [ap] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(ap!.status).toBe('approved');
    expect(ap!.resolvedBy).toBe('telegram');
    expect(ap!.notes).toContain('Always allowed');
  });

  it('annulation (wb) : la carte d’origine est restaurée avec ses TROIS boutons, rien résolu', async () => {
    const id = await insertPendingApproval();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:wb`, CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(true);
    if (!r.handled) throw new Error('unreachable');
    expect(r.decision).toBe('card_restored');

    const [ap] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(ap!.status).toBe('pending');

    const edits = editMessageBodies();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('Approbation requise');
    const buttons = edits[0]!.reply_markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `apr:${id}:a`,
      `apr:${id}:r`,
      `apr:${id}:w`,
    ]);
  });

  it('wc depuis un MAUVAIS chat : refusé, AUCUNE règle écrite', async () => {
    const id = await insertPendingApproval('skill_file_write');

    const r = await handleApprovalCallback({
      update: callbackUpdate(`apr:${id}:wc`, GUEST_CHAT_ID),
      receivingAgentId: seed.agentId,
      botToken: 'fake-token',
      deps,
      env,
    });

    expect(r.handled).toBe(false);
    if (r.handled) throw new Error('unreachable');
    expect(r.reason).toBe('chat_mismatch');

    const rules = await db
      .select()
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, seed.entityId),
          eq(approvalRules.toolName, 'skill_file_write'),
        ),
      );
    expect(rules, 'un chat non autorisé a posé une règle permanente').toHaveLength(0);
    const [ap] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(ap!.status).toBe('pending');
  });
});
