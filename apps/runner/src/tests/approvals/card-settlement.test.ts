// card-settlement.test.ts — une carte d'approbation suit le sort de sa demande,
// sur tous les canaux, quel que soit le chemin qui l'a tranchée (#637).
//
// Le symptôme : un job lancé par le serveur MCP (`channel = mcp`) lève une
// approbation ; la carte part sur Telegram (resolveTransportChannel). La demande
// expire parce que le run a été annulé — la carte reste, boutons actifs.
//
// Ce qui est prouvé ici, sur le contenu RÉELLEMENT envoyé au canal (texte +
// clavier), jamais sur un nombre d'appels :
//   - réponse ailleurs (dashboard)       → la carte Telegram dit la décision, boutons retirés
//   - expiration par le balayage (tick)  → la carte Discord dit « expirée »
//   - annulation de l'arbre              → la carte Telegram du job MCP dit « expirée »
//   - question répondue ailleurs         → la carte dit la réponse
//   - canal qui ne sait pas éditer       → rien n'est envoyé, et c'est DIT
//   - une carte n'est réécrite qu'une fois, même quand deux chemins passent

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  approvalRequests,
  approvalCardMessages,
  telegramAllowedChats,
  channelBindings,
  channelAllowedConversations,
  cancelJobTree,
} from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

// Discord et WhatsApp : des faux instrumentés, sans réseau. Telegram reste le
// VRAI adaptateur (→ sendTelegramMessage / editTelegramMessageText → le `fetch`
// remplacé plus bas) : c'est le corps HTTP réel qui est vérifié.
const { discordSendApprovalCardMock, discordEditMock, whatsappSendTextMock } = vi.hoisted(() => ({
  discordSendApprovalCardMock: vi.fn(async () => ({ messageId: 'discord-msg-77' })),
  discordEditMock: vi.fn(async () => {}),
  whatsappSendTextMock: vi.fn(async () => ({ messageId: 'wa-msg-9' })),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: (channel: string) => {
      if (channel === 'discord') {
        return {
          channel: 'discord',
          capabilities: { buttons: true, threads: true, media: true, editMessage: true },
          text: { renders: [], maxMessageChars: 2000 },
          sendText: vi.fn(async () => ({ messageId: 'unused' })),
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
          sendApprovalCard: discordSendApprovalCardMock,
          editMessageText: discordEditMock,
        };
      }
      if (channel === 'whatsapp') {
        return {
          channel: 'whatsapp',
          capabilities: { buttons: false, threads: false, media: true, editMessage: false },
          text: { renders: [], maxMessageChars: 4000 },
          sendText: whatsappSendTextMock,
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
        };
      }
      return actual.getAdapter(channel as Parameters<typeof actual.getAdapter>[0]);
    },
  };
});

import { notifyApprovalCreated } from '../../approvals/notify.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import { settleApprovalCards } from '../../approvals/card-settlement.ts';
import { runCronTick } from '../../cron/tick.ts';

const OWNER_CHAT = '199791464';
const TELEGRAM_CARD_MESSAGE_ID = 4242;

const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  const u = String(url);
  const result = u.includes('/sendMessage') ? { message_id: TELEGRAM_CARD_MESSAGE_ID } : true;
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
vi.stubGlobal('fetch', fetchMock);

const testEnv = {
  APP_URL: 'http://localhost:3099',
  WORKER_SECRET: 's',
  NODALAI_APPROVAL_GRACE_MS: 0,
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { entityId: string; agentId: string };

/** Les appels Telegram `editMessageText`, avec leur corps décodé. */
function telegramEdits(): Array<{
  chat_id: string;
  message_id: number;
  text: string;
  reply_markup: { inline_keyboard: unknown[] };
}> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/editMessageText'))
    .map(([, init]) => JSON.parse((init as unknown as RequestInit).body as string));
}

/** Un job + sa demande en attente, puis la carte envoyée par le vrai notify. */
async function gatedJob(opts: {
  channel: string;
  chatId?: string | null;
  kind?: 'approval' | 'question';
  toolName?: string;
  toolInput?: unknown;
  expiresAt?: Date;
}): Promise<{ jobId: string; approvalId: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: opts.channel,
      chatId: opts.chatId ?? null,
      task: `gated ${opts.channel} task`,
      status: 'awaiting_approval',
    })
    .returning();
  const toolName = opts.toolName ?? 'run_command';
  const toolInput = opts.toolInput ?? { command: 'rm -rf /tmp/x' };
  const [approval] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: job!.id,
      agentId: seed.agentId,
      toolName,
      toolInput,
      kind: opts.kind ?? 'approval',
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    })
    .returning();
  await notifyApprovalCreated(deps, {
    approvalRequestId: approval!.id,
    toolName,
    toolInput,
    jobId: job!.id,
    agentId: seed.agentId,
    entityId: seed.entityId,
    kind: opts.kind ?? 'approval',
  });
  return { jobId: job!.id, approvalId: approval!.id };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const minimal = await seedMinimal(db);
  seed = { entityId: minimal.entityId, agentId: minimal.agentId };
  deps = {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
  // Un agent joignable sur Telegram (bot + propriétaire) ET sur Discord et
  // WhatsApp : le canal de la carte est celui du job (ou, pour `mcp`, le
  // premier canal actif — Telegram), exactement comme en production.
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: OWNER_CHAT,
    role: 'owner',
    status: 'active',
  });
  for (const [channel, credentials, conversationId] of [
    ['discord', { botToken: 'discord-tok-1' }, 'discord-owner-chan-1'],
    ['whatsapp', { sessionDir: '/sessions/card-test' }, '15550000000@s.whatsapp.net'],
  ] as const) {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      credentials: JSON.stringify(credentials),
      enabled: true,
    });
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      conversationId,
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
  }
});

beforeEach(() => {
  fetchMock.mockClear();
  discordEditMock.mockClear();
  whatsappSendTextMock.mockClear();
});

describe('approval cards follow their request @cap:approuver-une-action/moteur', () => {
  it('records where the card went: channel, delivering agent, conversation, message id', async () => {
    const { approvalId } = await gatedJob({ channel: 'telegram', chatId: OWNER_CHAT });

    const rows = await db
      .select()
      .from(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, approvalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'telegram',
      agentId: seed.agentId,
      conversationId: OWNER_CHAT,
      messageId: String(TELEGRAM_CARD_MESSAGE_ID),
      settledAt: null,
    });
  });

  it('answered elsewhere (dashboard): the Telegram card states the decision and loses its buttons', async () => {
    const { approvalId } = await gatedJob({ channel: 'telegram', chatId: OWNER_CHAT });
    fetchMock.mockClear();

    const res = await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'reject',
      resolvedBy: 'api',
    });
    expect(res.ok).toBe(true);

    expect(telegramEdits()).toEqual([
      {
        chat_id: OWNER_CHAT,
        message_id: TELEGRAM_CARD_MESSAGE_ID,
        text: '❌ Rejected — run_command',
        reply_markup: { inline_keyboard: [] },
      },
    ]);
  });

  it('expired by the TTL sweep: the cron tick rewrites the Discord card as expired', async () => {
    const { approvalId } = await gatedJob({
      channel: 'discord',
      chatId: 'discord-owner-chan-1',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(discordSendApprovalCardMock).toHaveBeenCalled();

    const tick = await runCronTick(deps);

    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(row?.status).toBe('expired');
    expect(tick.approvalCardsSettled).toBeGreaterThanOrEqual(1);
    expect(discordEditMock.mock.calls).toEqual([
      [
        { botToken: 'discord-tok-1' },
        'discord-owner-chan-1',
        'discord-msg-77',
        '⌛ Expired — run_command',
      ],
    ]);
  });

  it('expired because its run was cancelled (cancelJobTree): the Telegram card of the MCP job says so', async () => {
    // Le scénario du ticket : job racine `mcp`, approbation levée par son
    // ENFANT délégué, puis l'arbre annulé (bouton Stop du web / `/stop`).
    fetchMock.mockClear();
    const [root] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'mcp',
        task: 'mcp root',
        status: 'awaiting_delegation',
      })
      .returning();
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        // Le job MCP n'a pas de conversation ; son délégué en porte une
        // (`delegate.ts` : `taskInput.chatId ?? parent.chatId`) — c'est ainsi
        // que la carte du job 75bbf3d0 a trouvé le chat du propriétaire.
        chatId: OWNER_CHAT,
        parentJobId: root!.id,
        task: 'delegated child',
        status: 'awaiting_approval',
      })
      .returning();
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: child!.id,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'npm i' },
      })
      .returning();
    await notifyApprovalCreated(deps, {
      approvalRequestId: approval!.id,
      toolName: 'run_command',
      toolInput: { command: 'npm i' },
      jobId: child!.id,
      agentId: seed.agentId,
      entityId: seed.entityId,
      kind: 'approval',
    });
    // La carte est partie sur Telegram alors que la racine est `mcp`.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/sendMessage')),
    ).toHaveLength(1);
    fetchMock.mockClear();

    const cancelled = await cancelJobTree(db, { entityId: seed.entityId, jobId: root!.id });
    expect(cancelled?.requestIds).toEqual([approval!.id]);
    // L'annulation vit dans @nodal-agents/db et part aussi du web : le point de
    // mise à jour la rattrape sans que `cancelJobTree` sache qu'une carte existe.
    await settleApprovalCards(db);

    expect(telegramEdits()).toEqual([
      {
        chat_id: OWNER_CHAT,
        message_id: TELEGRAM_CARD_MESSAGE_ID,
        text: '⌛ Expired — run_command',
        reply_markup: { inline_keyboard: [] },
      },
    ]);
  });

  it('a question answered elsewhere: its Telegram card shows the chosen option, buttons gone', async () => {
    const { approvalId } = await gatedJob({
      channel: 'telegram',
      chatId: OWNER_CHAT,
      kind: 'question',
      toolName: 'ask_user',
      toolInput: { question: 'Which size?', options: ['Small', 'Large'] },
    });
    fetchMock.mockClear();

    const res = await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'approve',
      answer: 'Large',
      resolvedBy: 'api',
    });
    expect(res.ok).toBe(true);

    expect(telegramEdits()).toEqual([
      {
        chat_id: OWNER_CHAT,
        message_id: TELEGRAM_CARD_MESSAGE_ID,
        text: '✅ Answered: Large',
        reply_markup: { inline_keyboard: [] },
      },
    ]);
  });

  it('a channel that cannot edit (WhatsApp): nothing is sent, and the outcome SAYS the card is left as sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { approvalId } = await gatedJob({
        channel: 'whatsapp',
        chatId: '15550000000@s.whatsapp.net',
      });
      expect(whatsappSendTextMock).toHaveBeenCalledTimes(1);
      whatsappSendTextMock.mockClear();
      await db
        .update(approvalRequests)
        .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'api' })
        .where(eq(approvalRequests.id, approvalId));

      const outcomes = await settleApprovalCards(db, { approvalRequestIds: [approvalId] });

      expect(outcomes).toEqual([
        expect.objectContaining({
          approvalRequestId: approvalId,
          channel: 'whatsapp',
          outcome: 'cannot_edit',
        }),
      ]);
      const detail = (outcomes[0] as { detail: string }).detail;
      expect(detail).toContain('whatsapp cannot edit a sent message');
      expect(detail).toContain('wa-msg-9');
      expect(detail).toContain('approved');
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`[approval-card] ${detail}`);
      // Aucun nouveau message pour « compenser » : le canal ne l'a pas demandé.
      expect(whatsappSendTextMock.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a card is rewritten once: the sweep after an answer finds nothing left to do', async () => {
    const { approvalId } = await gatedJob({ channel: 'telegram', chatId: OWNER_CHAT });
    await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'approve',
      resolvedBy: 'api',
    });
    fetchMock.mockClear();

    const again = await settleApprovalCards(db);

    expect(again.filter((o) => o.approvalRequestId === approvalId)).toEqual([]);
    expect(telegramEdits()).toEqual([]);
    const [row] = await db
      .select({ settledAt: approvalCardMessages.settledAt })
      .from(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, approvalId));
    expect(row?.settledAt).toBeInstanceOf(Date);
  });

  it('a card whose request is still pending is left alone', async () => {
    const { approvalId } = await gatedJob({ channel: 'telegram', chatId: OWNER_CHAT });
    fetchMock.mockClear();

    const outcomes = await settleApprovalCards(db, { approvalRequestIds: [approvalId] });

    expect(outcomes).toEqual([]);
    expect(telegramEdits()).toEqual([]);
  });
});
