// notify.test.ts — deterministic, server-sent approval card.
//
// This is the fix for "AUCUN message Telegram on approval": the runner must send
// the card itself (not via an LLM nudge), with ✅/❌ inline buttons, whenever the
// job has a Telegram chat + the agent has a bot token — and stay silent otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  telegramAllowedChats,
  channelBindings,
  channelAllowedConversations,
  entities,
  users,
} from '@nodal-agents/db';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../../deps.ts';

// W2: discord/whatsapp coverage below needs getAdapter to return
// INSTRUMENTED, network-free fakes for those two channels — a real
// whatsappAdapter.sendText would attempt an actual Baileys socket
// (filesystem + websocket), and a real discordAdapter would hit Discord's
// REST API. The telegram path is left COMPLETELY untouched: `importOriginal`
// spreads the real module, so telegram tests below still exercise the real
// telegramAdapter → sendTelegramMessage → the stubbed global `fetch` — byte-
// identical to before this mock existed.
const { discordSendApprovalCardMock, whatsappSendTextMock } = vi.hoisted(() => ({
  discordSendApprovalCardMock: vi.fn(async () => ({ messageId: 'discord-msg-1' })),
  whatsappSendTextMock: vi.fn(async () => ({ messageId: 'wa-msg-1' })),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: (channel: string) => {
      if (channel === 'discord') {
        return {
          channel: 'discord',
          capabilities: { buttons: true, threads: true, media: true, editMessage: true },
          sendText: vi.fn(async () => ({ messageId: 'unused' })),
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
          sendApprovalCard: discordSendApprovalCardMock,
        };
      }
      if (channel === 'whatsapp') {
        return {
          channel: 'whatsapp',
          capabilities: { buttons: false, threads: false, media: true, editMessage: false },
          sendText: whatsappSendTextMock,
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
        };
      }
      return actual.getAdapter(channel as Parameters<typeof actual.getAdapter>[0]);
    },
  };
});

import {
  notifyApprovalCreated,
  resolveTelegramDeliveryTarget,
  resolveApprovalDeliveryTarget,
} from '../../approvals/notify.ts';

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string; llmKeyId: string };

// CHAT_ID doubles as the bot OWNER's private chat — the common case where the
// owner talks to their own bot, so the card lands where the job already ran.
// GUEST_CHAT_ID is used by the self-approval test below, where the job's own
// chat must NOT be where the card is delivered.
const CHAT_ID = '199791464';
const GUEST_CHAT_ID = '555000111';
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
  // The bot OWNER of record — resolveApprovalDeliveryTarget (called by
  // notifyApprovalCreated) resolves the card's chat from THIS row, never
  // straight from agent_jobs.chat_id. Every test below sets the job's own
  // chat_id to CHAT_ID too, so this is a no-op for them (owner == origin);
  // the self-approval test further down deliberately diverges the two.
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
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

  it('SECURITY: a guest-triggered job delivers the card to the OWNER chat, not the guest chat', async () => {
    // The self-approval hole this fix closes: an authorized non-owner
    // ('member', H-1) DMs the bot and triggers a gated action. The card must
    // reach the OWNER (CHAT_ID, seeded in beforeAll), never GUEST_CHAT_ID —
    // otherwise the guest could tap ✅ on their own action.
    await db.update(agentJobs).set({ chatId: GUEST_CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: '123:fake' })
      .where(eq(agents.id, seed.agentId));
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: GUEST_CHAT_ID,
      role: 'member',
      status: 'active',
    });

    await notifyApprovalCreated(deps, req());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { chat_id: string };
    expect(body.chat_id).toBe(CHAT_ID); // NOT GUEST_CHAT_ID
  });

  it('stays silent when the bot has no owner on record (fail loud, no fallback to the triggering chat)', async () => {
    // A distinct bot/agent with a token but no `role='owner'` row — the
    // defensive branch of resolveApprovalDeliveryTarget. Should not occur in
    // practice (H-1: an active member implies an owner), but must never fall
    // back to sending the card to whatever chat triggered the job.
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
      })
      .returning();

    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000fa',
      toolName: 'run_command',
      toolInput: { command: 'echo hi' },
      jobId: job!.id,
      agentId: ownerlessAgent!.id,
      entityId: seed.entityId,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveTelegramDeliveryTarget: entity boundary assertion (F2)', () => {
  it('a 2-hop chain within one entity still resolves — regression', async () => {
    // Orchestrator (root) — has the bot + the chat.
    await db.update(agentJobs).set({ chatId: CHAT_ID }).where(eq(agentJobs.id, seed.jobId));
    await db
      .update(agents)
      .set({ telegramBotToken: 'regression:bot' })
      .where(eq(agents.id, seed.agentId));

    // Bot-less delegate, correctly parented WITHIN the same entity.
    const [delegate] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Same-Entity Delegate',
        slug: `same-entity-delegate-${Date.now()}`,
        personality: 'sub-agent',
        llmKeyId: seed.llmKeyId,
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
        task: 'same-entity delegated job',
      })
      .returning();

    const target = await resolveTelegramDeliveryTarget(deps.db, childJob!.id);
    expect(target).toEqual({
      agentId: seed.agentId,
      botToken: 'regression:bot',
      chatId: CHAT_ID,
    });
  });

  it('SECURITY: a chain that crosses an entity boundary returns null and never leaks the foreign bot token', async () => {
    // Foreign entity, with its own bot-owning agent and job — stands in for a
    // corrupt/foreign parent_job_id (bug, or a future cross-entity delegation
    // path). If the walk didn't check entity_id, this bot token + chat would
    // be returned to a DIFFERENT tenant's job.
    const [foreignUser] = await db
      .insert(users)
      .values({ email: `f2-foreign-user-${Date.now()}@example.com` })
      .returning();
    const [foreignEntity] = await db
      .insert(entities)
      .values({
        userId: foreignUser!.id,
        name: 'F2 Foreign Entity',
        slug: `f2-foreign-entity-${Date.now()}`,
      })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        entityId: foreignEntity!.id,
        name: 'Foreign Bot Owner',
        slug: `f2-foreign-bot-${Date.now()}`,
        personality: 'test',
        telegramBotToken: 'foreign:secret-bot',
      })
      .returning();
    const [foreignJob] = await db
      .insert(agentJobs)
      .values({
        entityId: foreignEntity!.id,
        agentId: foreignAgent!.id,
        channel: 'internal',
        chatId: 'foreign-chat-id',
        task: 'foreign ancestor job',
      })
      .returning();

    // Bot-less delegate in the ORIGINAL entity, corruptly parented to the
    // foreign job — a plain parent_job_id walk (no entity check) would climb
    // straight into it and return the foreign bot.
    const [delegate] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Cross-Entity Delegate',
        slug: `f2-cross-entity-delegate-${Date.now()}`,
        personality: 'sub-agent',
        llmKeyId: seed.llmKeyId,
      })
      .returning();
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: delegate!.id,
        channel: 'internal',
        chatId: CHAT_ID,
        parentJobId: foreignJob!.id,
        task: 'cross-entity delegated job',
      })
      .returning();

    const target = await resolveTelegramDeliveryTarget(deps.db, childJob!.id);
    expect(target).toBeNull();

    // Same guard applies to the approval-card resolver (it calls the base
    // function above — no separate walk to duplicate the fix in).
    const approvalTarget = await resolveApprovalDeliveryTarget(deps.db, childJob!.id);
    expect(approvalTarget).toBeNull();

    // End-to-end: the deterministic notifier must stay fully silent too.
    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000fb',
      toolName: 'run_command',
      toolInput: { command: 'echo pwned' },
      jobId: childJob!.id,
      agentId: delegate!.id,
      entityId: seed.entityId,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── notifyApprovalCreated — channel-parametric delivery (W2) ───────────────
//
// Telegram's own tests above are UNTOUCHED and must stay green (they prove
// the byte-identical regression). These cover the generalization: a
// buttons-capable channel (discord, standing in for slack too — same
// capabilities.buttons=true path) still gets sendApprovalCard; a
// no-buttons channel (whatsapp) falls back to sendText with an explicit
// dashboard pointer instead of silently swallowing the notification (the
// bug a bare `sendApprovalCard!` non-null assertion used to hit).

describe('notifyApprovalCreated — channel-parametric delivery (W2)', () => {
  it('discord job (buttons capability) → sendApprovalCard via the discord adapter', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'discord-tok-1' }),
      enabled: true,
    });
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: 'discord-owner-chan-1',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        chatId: 'discord-owner-chan-1',
        task: 'discord-triggered task',
      })
      .returning();

    discordSendApprovalCardMock.mockClear();
    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000d1',
      toolName: 'run_command',
      toolInput: { command: 'echo discord' },
      jobId: job!.id,
      agentId: seed.agentId,
      entityId: seed.entityId,
    });

    expect(discordSendApprovalCardMock).toHaveBeenCalledTimes(1);
    const [creds, conversationId, card] = discordSendApprovalCardMock.mock.calls[0] as unknown as [
      unknown,
      string,
      { callbackId: string; text: string },
    ];
    expect(creds).toEqual({ botToken: 'discord-tok-1' });
    expect(conversationId).toBe('discord-owner-chan-1');
    expect(card.callbackId).toBe('apr:00000000-0000-0000-0000-0000000000d1');
    expect(card.text).toContain('echo discord');
  });

  it('whatsapp job (no buttons capability) → sendText fallback with the dashboard closing line, never throws', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/notify-test' }),
      enabled: true,
    });
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      conversationId: '15550000000@s.whatsapp.net',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'whatsapp',
        chatId: '15550000000@s.whatsapp.net',
        task: 'whatsapp-triggered task',
      })
      .returning();

    whatsappSendTextMock.mockClear();
    await expect(
      notifyApprovalCreated(deps, {
        approvalRequestId: '00000000-0000-0000-0000-0000000000d2',
        toolName: 'run_command',
        toolInput: { command: 'echo whatsapp' },
        jobId: job!.id,
        agentId: seed.agentId,
        entityId: seed.entityId,
      }),
    ).resolves.toBeUndefined();

    expect(whatsappSendTextMock).toHaveBeenCalledTimes(1);
    const [creds, conversationId, text] = whatsappSendTextMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
    ];
    expect(creds).toEqual({ sessionDir: '/sessions/notify-test' });
    expect(conversationId).toBe('15550000000@s.whatsapp.net');
    expect(text).toContain('echo whatsapp');
    expect(text).toContain('Approve or reject from the dashboard: Approvals page.');
  });

  it('SECURITY: the entity-boundary guard still applies to the generalized (discord) walk', async () => {
    // Mirrors the telegram SECURITY test above, but for a chain whose root
    // resolves to discord instead of telegram — proves the generalization
    // didn't drop the boundary check on the way.
    const [foreignUser] = await db
      .insert(users)
      .values({ email: `w2-foreign-user-${Date.now()}@example.com` })
      .returning();
    const [foreignEntity] = await db
      .insert(entities)
      .values({
        userId: foreignUser!.id,
        name: 'W2 Foreign Entity',
        slug: `w2-foreign-entity-${Date.now()}`,
      })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        entityId: foreignEntity!.id,
        name: 'W2 Foreign Bot Owner',
        slug: `w2-foreign-bot-${Date.now()}`,
        personality: 'test',
      })
      .returning();
    const [foreignJob] = await db
      .insert(agentJobs)
      .values({
        entityId: foreignEntity!.id,
        agentId: foreignAgent!.id,
        channel: 'discord',
        chatId: 'foreign-discord-chan',
        task: 'foreign ancestor job',
      })
      .returning();

    const [delegate] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'W2 Cross-Entity Delegate',
        slug: `w2-cross-entity-delegate-${Date.now()}`,
        personality: 'sub-agent',
        llmKeyId: seed.llmKeyId,
      })
      .returning();
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: delegate!.id,
        channel: 'internal',
        chatId: 'discord-owner-chan-1',
        parentJobId: foreignJob!.id,
        task: 'cross-entity delegated discord job',
      })
      .returning();

    discordSendApprovalCardMock.mockClear();
    await notifyApprovalCreated(deps, {
      approvalRequestId: '00000000-0000-0000-0000-0000000000d3',
      toolName: 'run_command',
      toolInput: { command: 'echo pwned' },
      jobId: childJob!.id,
      agentId: delegate!.id,
      entityId: seed.entityId,
    });

    expect(discordSendApprovalCardMock).not.toHaveBeenCalled();
  });
});
