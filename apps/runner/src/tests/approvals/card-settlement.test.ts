// card-settlement.test.ts — une carte d'approbation suit le sort de sa demande,
// sur tous les canaux, quel que soit le chemin qui l'a tranchée (#637).
//
// Le symptôme : un job lancé par le serveur MCP (`channel = mcp`) lève une
// approbation ; la carte part sur Telegram (resolveTransportChannel). La demande
// expire parce que le run a été annulé — la carte reste, boutons actifs.
//
// Ce qui est prouvé ici, sur le contenu RÉELLEMENT envoyé au canal (texte +
// clavier) et sur la ligne de la carte en base, jamais sur un nombre d'appels :
//   - réponse ailleurs (dashboard)       → la carte Telegram dit la décision, boutons retirés
//   - expiration par le balayage (tick)  → la carte Discord dit « expirée »
//   - annulation de l'arbre              → la carte Telegram du job MCP dit « expirée »
//   - question répondue ailleurs         → la carte dit la réponse
//   - canal qui ne sait pas éditer       → rien n'est envoyé, et c'est DIT
//   - une édition ratée n'est pas un succès : reprise au tick suivant, bornée, abandon dit
//   - le clic sur la carte : UNE écriture, par le même point, avec le même texte
//   - la course du « Toujours autoriser » ne laisse pas de boutons sur une demande close

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
  entities,
} from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

// Discord et WhatsApp : des faux instrumentés, sans réseau. Telegram reste le
// VRAI adaptateur (→ sendTelegramMessage / editTelegramMessageText → le `fetch`
// remplacé plus bas) : c'est le corps HTTP réel qui est vérifié.
const { discordSendApprovalCardMock, discordEditMock, whatsappSendTextMock } = vi.hoisted(() => ({
  discordSendApprovalCardMock: vi.fn(async () => ({ messageId: 'discord-msg-77' })),
  discordEditMock: vi.fn(
    async (
      _creds: unknown,
      _conversationId: string,
      _messageId: string,
      _text: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }),
  ),
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
import {
  settleApprovalCards,
  showApprovalCard,
  APPROVAL_CARD_MAX_ATTEMPTS,
} from '../../approvals/card-settlement.ts';
import { runCronTick } from '../../cron/tick.ts';
import { handleApprovalCallback } from '../../telegram/approval-callback.ts';
import { handleDiscordApprovalInteraction } from '../../channels/discord/approval-callback.ts';
import type { TelegramUpdate } from '@nodal-agents/delivery';

const OWNER_CHAT = '199791464';
const TELEGRAM_CARD_MESSAGE_ID = 4242;
const DISCORD_OWNER_CHANNEL = 'discord-owner-chan-1';

/** Un crochet appelé UNE fois sur la prochaine édition Telegram (simule ce qui se passe pendant). */
let onNextTelegramEdit: ((body: Record<string, unknown>) => Promise<void>) | null = null;
/**
 * Les éditions Telegram dans l'ordre où elles ABOUTISSENT — l'état final de la
 * carte chez Telegram est celui de la dernière. (`mock.calls` suit l'ordre des
 * appels, pas des réponses : faux dès qu'une édition en chevauche une autre.)
 */
const completedTelegramEdits: Array<Record<string, unknown>> = [];
/** Telegram répond 429 à toute édition tant que c'est vrai. */
let failTelegramEdits = false;

const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/editMessageText') && onNextTelegramEdit) {
    const hook = onNextTelegramEdit;
    onNextTelegramEdit = null;
    await hook(JSON.parse(init?.body as string) as Record<string, unknown>);
  }
  if (u.includes('/editMessageText') && failTelegramEdits) {
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  }
  if (u.includes('/editMessageText')) {
    completedTelegramEdits.push(JSON.parse(init?.body as string) as Record<string, unknown>);
  }
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

interface TelegramEditBody {
  chat_id: string;
  message_id: number;
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/** Les appels Telegram `editMessageText`, avec leur corps décodé. */
function telegramEdits(): TelegramEditBody[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/editMessageText'))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as TelegramEditBody);
}

function noButtons(text: string): TelegramEditBody {
  return {
    chat_id: OWNER_CHAT,
    message_id: TELEGRAM_CARD_MESSAGE_ID,
    text,
    reply_markup: { inline_keyboard: [] },
  };
}

async function cardRow(approvalId: string) {
  const [row] = await db
    .select()
    .from(approvalCardMessages)
    .where(eq(approvalCardMessages.approvalRequestId, approvalId));
  return row!;
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

const telegramCard = () => gatedJob({ channel: 'telegram', chatId: OWNER_CHAT });
const discordCard = (expiresAt?: Date) =>
  gatedJob({
    channel: 'discord',
    chatId: DISCORD_OWNER_CHANNEL,
    ...(expiresAt ? { expiresAt } : {}),
  });

/** Le clic Telegram sur la carte, tel que le poller le reçoit. */
function tap(data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: { id: Number(OWNER_CHAT), is_bot: false, first_name: 'Owner' },
      data,
      message: {
        message_id: TELEGRAM_CARD_MESSAGE_ID,
        chat: { id: Number(OWNER_CHAT), type: 'private' },
      },
    },
  } as unknown as TelegramUpdate;
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
    ['discord', { botToken: 'discord-tok-1' }, DISCORD_OWNER_CHANNEL],
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
  discordEditMock.mockReset();
  discordEditMock.mockImplementation(async () => ({ ok: true }));
  whatsappSendTextMock.mockClear();
  onNextTelegramEdit = null;
  completedTelegramEdits.length = 0;
  failTelegramEdits = false;
});

describe('approval cards follow their request @cap:approuver-une-action/moteur', () => {
  it('records where the card went: channel, delivering agent, conversation, message id', async () => {
    const { approvalId } = await telegramCard();

    expect(await cardRow(approvalId)).toMatchObject({
      channel: 'telegram',
      agentId: seed.agentId,
      conversationId: OWNER_CHAT,
      messageId: String(TELEGRAM_CARD_MESSAGE_ID),
      attempts: 0,
      settledAt: null,
      outcome: null,
    });
  });

  it('answered elsewhere (dashboard): the Telegram card states the decision and loses its buttons', async () => {
    const { approvalId } = await telegramCard();
    fetchMock.mockClear();

    const res = await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'reject',
      resolvedBy: 'api',
    });
    expect(res.ok).toBe(true);

    expect(telegramEdits()).toEqual([noButtons('❌ Rejected — run_command')]);
    expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited', attempts: 1 });
  });

  it('expired by the TTL sweep: the cron tick rewrites the Discord card as expired, and counts exactly it', async () => {
    const { approvalId } = await discordCard(new Date(Date.now() - 60_000));

    const tick = await runCronTick(deps);

    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(row?.status).toBe('expired');
    expect({
      edited: tick.approvalCardsEdited,
      failed: tick.approvalCardsFailed,
      notEditable: tick.approvalCardsNotEditable,
    }).toEqual({ edited: 1, failed: 0, notEditable: 0 });
    expect(discordEditMock.mock.calls).toEqual([
      [
        { botToken: 'discord-tok-1' },
        DISCORD_OWNER_CHANNEL,
        'discord-msg-77',
        '⌛ Expired — run_command',
      ],
    ]);
  });

  it('expired because its run was cancelled (cancelJobTree): the Telegram card of the MCP job says so', async () => {
    // Le scénario du ticket : job racine `mcp`, approbation levée par son
    // ENFANT délégué, puis l'arbre annulé (bouton Stop du web / `/stop`).
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
    await settleApprovalCards(deps.db);

    expect(telegramEdits()).toEqual([noButtons('⌛ Expired — run_command')]);
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

    expect(telegramEdits()).toEqual([noButtons('✅ Answered: Large')]);
  });

  it('a channel that cannot edit (WhatsApp): nothing is sent, the card is closed as cannot_edit, and it is SAID', async () => {
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

      const outcomes = await settleApprovalCards(deps.db, { approvalRequestIds: [approvalId] });

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
      expect(await cardRow(approvalId)).toMatchObject({
        outcome: 'cannot_edit',
        lastError: detail,
      });
      // Aucun nouveau message pour « compenser » : le canal ne l'a pas demandé.
      expect(whatsappSendTextMock.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a card is rewritten once: the sweep after an answer finds nothing left to do', async () => {
    const { approvalId } = await telegramCard();
    await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'approve',
      resolvedBy: 'api',
    });
    fetchMock.mockClear();

    const again = await settleApprovalCards(deps.db);

    expect(again.filter((o) => o.approvalRequestId === approvalId)).toEqual([]);
    expect(telegramEdits()).toEqual([]);
    expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited' });
  });

  it('a card whose request is still pending is left alone', async () => {
    const { approvalId } = await telegramCard();
    fetchMock.mockClear();

    const outcomes = await settleApprovalCards(deps.db, { approvalRequestIds: [approvalId] });

    expect(outcomes).toEqual([]);
    expect(telegramEdits()).toEqual([]);
    expect(await cardRow(approvalId)).toMatchObject({ attempts: 0, settledAt: null });
  });
});

describe('a failed edit is not a success @cap:approuver-une-action/moteur', () => {
  it('an edit that fails is retried on the next tick, and succeeds there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { approvalId } = await discordCard();
      discordEditMock.mockImplementationOnce(async () => ({ ok: false, error: 'HTTP 500' }));

      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'approve',
        resolvedBy: 'api',
      });

      // Pas finie : la raison est gardée, la carte reste à reprendre.
      expect(await cardRow(approvalId)).toMatchObject({
        attempts: 1,
        lastError: 'HTTP 500',
        settledAt: null,
        outcome: null,
        claimedAt: null,
      });

      const tick = await runCronTick(deps);

      expect({ edited: tick.approvalCardsEdited, failed: tick.approvalCardsFailed }).toEqual({
        edited: 1,
        failed: 0,
      });
      expect(discordEditMock.mock.calls.map((c) => c[3])).toEqual([
        '✅ Approved — run_command',
        '✅ Approved — run_command',
      ]);
      expect(await cardRow(approvalId)).toMatchObject({ attempts: 2, outcome: 'edited' });
    } finally {
      warn.mockRestore();
    }
  });

  it('a tick whose edit fails counts it as failed, never as updated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { approvalId } = await discordCard(new Date(Date.now() - 60_000));
      discordEditMock.mockImplementation(async () => ({ ok: false, error: 'HTTP 502' }));

      const tick = await runCronTick(deps);

      expect({ edited: tick.approvalCardsEdited, failed: tick.approvalCardsFailed }).toEqual({
        edited: 0,
        failed: 1,
      });
      expect(await cardRow(approvalId)).toMatchObject({ settledAt: null, lastError: 'HTTP 502' });

      // Le canal revient : le tick suivant la met à jour.
      discordEditMock.mockImplementation(async () => ({ ok: true }));
      await runCronTick(deps);
      expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited', attempts: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  it(`gives up after ${APPROVAL_CARD_MAX_ATTEMPTS} failed edits, SAYS so, and never takes the card again`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { approvalId } = await discordCard();
      discordEditMock.mockImplementation(async () => ({ ok: false, error: 'Unknown Message' }));
      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'reject',
        resolvedBy: 'api',
      });

      const outcomes: string[] = [];
      for (let i = 0; i < APPROVAL_CARD_MAX_ATTEMPTS; i += 1) {
        const o = await settleApprovalCards(deps.db, { approvalRequestIds: [approvalId] });
        outcomes.push(o.map((x) => x.outcome).join(',') || 'nothing');
      }

      // L'appel dans resolve a fait la 1re tentative ; 2..4 reprennent, la 5e
      // abandonne, la suivante ne prend plus rien.
      expect(outcomes).toEqual([
        ...Array.from({ length: APPROVAL_CARD_MAX_ATTEMPTS - 2 }, () => 'will_retry'),
        'gave_up',
        'nothing',
      ]);
      expect(await cardRow(approvalId)).toMatchObject({
        attempts: APPROVAL_CARD_MAX_ATTEMPTS,
        outcome: 'gave_up',
        lastError: 'Unknown Message',
      });
      expect(error.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining(
          `gave up updating the discord card for approval ${approvalId} (message discord-msg-77) ` +
            `after ${APPROVAL_CARD_MAX_ATTEMPTS} failed attempts`,
        ),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('missing credentials are a transient failure: the card is updated once they are back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { approvalId } = await telegramCard();
      await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
      fetchMock.mockClear();

      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'approve',
        resolvedBy: 'api',
      });

      expect(telegramEdits()).toEqual([]);
      expect(await cardRow(approvalId)).toMatchObject({
        settledAt: null,
        lastError: `no usable telegram credentials for agent ${seed.agentId}`,
      });

      await db
        .update(agents)
        .set({ telegramBotToken: '123:fake' })
        .where(eq(agents.id, seed.agentId));
      await settleApprovalCards(deps.db);

      expect(telegramEdits()).toEqual([noButtons('✅ Approved — run_command')]);
      expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited', attempts: 2 });
    } finally {
      await db
        .update(agents)
        .set({ telegramBotToken: '123:fake' })
        .where(eq(agents.id, seed.agentId));
      warn.mockRestore();
    }
  });

  it('an error reading the cards reaches the caller (the tick reports it) instead of looking like "nothing to do"', async () => {
    const broken = {
      select: deps.db.select.bind(deps.db),
      update: () => {
        throw new Error('db down');
      },
    } as unknown as RunnerDeps['db'];

    await expect(settleApprovalCards(broken)).rejects.toThrow('db down');
  });
});

describe('a tap on the card: one write, the same text @cap:approuver-une-action/moteur', () => {
  it('Telegram ✅: the card is rewritten ONCE, by the settlement point', async () => {
    const { approvalId } = await telegramCard();
    fetchMock.mockClear();

    const r = await handleApprovalCallback({
      update: tap(`apr:${approvalId}:a`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(r).toMatchObject({ handled: true, decision: 'approve' });
    expect(telegramEdits()).toEqual([noButtons('✅ Approved — run_command')]);
  });

  it('Telegram « Always allow » confirmed: ONE write, and it says the tool will now run without asking', async () => {
    // Un outil à lui : la règle posée ici couvre CET outil pour cet agent, et
    // les autres tests de ce fichier ne doivent pas en hériter.
    const { approvalId } = await gatedJob({
      channel: 'telegram',
      chatId: OWNER_CHAT,
      toolName: 'skill_file_write',
      toolInput: { skill: 'notes', path: 'SKILL.md' },
    });
    fetchMock.mockClear();

    const r = await handleApprovalCallback({
      update: tap(`apr:${approvalId}:wc`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(r).toMatchObject({ handled: true, decision: 'approve' });
    expect(telegramEdits()).toEqual([
      noButtons('✅ Approved — skill_file_write will now run without asking for Test Agent.'),
    ]);
  });

  it('« Always allow » under the auto-run brake: the card says it will keep asking (same text, from the same point)', async () => {
    const { approvalId } = await gatedJob({
      channel: 'telegram',
      chatId: OWNER_CHAT,
      toolName: 'run_skill_script',
      toolInput: { skill: 'notes', script: 'build.sh' },
    });
    await db.update(entities).set({ autoRunPaused: true }).where(eq(entities.id, seed.entityId));
    fetchMock.mockClear();
    try {
      await handleApprovalCallback({
        update: tap(`apr:${approvalId}:wc`),
        receivingAgentId: seed.agentId,
        botToken: '123:fake',
        deps,
        env: testEnv,
      });

      expect(telegramEdits()).toEqual([
        noButtons(
          '✅ Approved — run_skill_script will now run without asking for Test Agent. ' +
            'The workspace auto-run brake is engaged, so it will keep asking until you release it in Settings.',
        ),
      ]);
    } finally {
      await db.update(entities).set({ autoRunPaused: false }).where(eq(entities.id, seed.entityId));
    }
  });

  it('Discord ✅: the tap is acknowledged BEFORE the decision, without a write, and the card is rewritten ONCE by the settlement point', async () => {
    const { approvalId } = await discordCard();
    // L'ordre prouvé par le RÉSULTAT : ce que la demande était au moment de
    // l'acquittement — encore ouverte, donc acquittée avant la décision.
    const acks = {
      acknowledgedWhile: [] as Array<string | null>,
      resolveCard: [] as string[],
      ephemeral: [] as string[],
    };

    const r = await handleDiscordApprovalInteraction({
      parsed: { approvalRequestId: approvalId, decision: 'approve' },
      channelId: DISCORD_OWNER_CHANNEL,
      channelType: 'dm',
      receivingAgentId: seed.agentId,
      ack: {
        async ephemeralReply(text: string) {
          acks.ephemeral.push(text);
        },
        async resolveCard(text: string) {
          acks.resolveCard.push(text);
        },
        async acknowledge() {
          const [row] = await db
            .select({ status: approvalRequests.status })
            .from(approvalRequests)
            .where(eq(approvalRequests.id, approvalId));
          acks.acknowledgedWhile.push(row?.status ?? null);
        },
      },
      deps,
      env: testEnv,
    });

    expect(r).toMatchObject({ handled: true, decision: 'approve' });
    expect(acks).toEqual({ acknowledgedWhile: ['pending'], resolveCard: [], ephemeral: [] });
    expect(discordEditMock.mock.calls).toEqual([
      [
        { botToken: 'discord-tok-1' },
        DISCORD_OWNER_CHANNEL,
        'discord-msg-77',
        '✅ Approved — run_command',
      ],
    ]);
  });

  it('race: the request expires while « Always allow? » is being shown — the card ends without buttons, saying expired', async () => {
    const { approvalId } = await telegramCard();
    fetchMock.mockClear();
    // Pendant l'édition en question de confirmation, le balayage expire la
    // demande et le point de mise à jour réécrit la carte « Expired » — AVANT
    // que l'édition de confirmation (boutons wc/wb) n'arrive chez Telegram.
    onNextTelegramEdit = async () => {
      await db
        .update(approvalRequests)
        .set({ status: 'expired', resolvedAt: new Date(), resolvedBy: 'system:ttl_expired' })
        .where(eq(approvalRequests.id, approvalId));
      await settleApprovalCards(deps.db, { approvalRequestIds: [approvalId] });
    };

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:w`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits.at(-1)).toEqual(noButtons('⌛ Expired — run_command'));
  });

  it('race: the request is answered elsewhere while « Back » restores the card — the card ends without buttons', async () => {
    const { approvalId } = await telegramCard();
    fetchMock.mockClear();
    onNextTelegramEdit = async () => {
      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'reject',
        resolvedBy: 'api',
      });
    };

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:wb`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits.at(-1)).toEqual(noButtons('❌ Rejected — run_command'));
  });
});

describe('every write of a card goes through the card protocol @cap:approuver-une-action/moteur', () => {
  it('a 429 streak makes the card give up; a tap on it puts it back in the queue, and the tick repairs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { approvalId } = await telegramCard();
      failTelegramEdits = true;
      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'approve',
        resolvedBy: 'api',
      });
      for (let i = 1; i < APPROVAL_CARD_MAX_ATTEMPTS; i += 1) {
        await settleApprovalCards(deps.db, { approvalRequestIds: [approvalId] });
      }
      expect(await cardRow(approvalId)).toMatchObject({
        outcome: 'gave_up',
        lastError: 'telegram_request_failed: Too Many Requests: retry after 5',
      });

      // Le propriétaire tape la carte morte, Telegram refuse encore une fois.
      await handleApprovalCallback({
        update: tap(`apr:${approvalId}:a`),
        receivingAgentId: seed.agentId,
        botToken: '123:fake',
        deps,
        env: testEnv,
      });
      expect(await cardRow(approvalId)).toMatchObject({
        settledAt: null,
        outcome: null,
        attempts: 1,
      });

      // Telegram revient : le tick répare la carte.
      failTelegramEdits = false;
      const tick = await runCronTick(deps);

      expect(tick.approvalCardsEdited).toBe(1);
      expect(completedTelegramEdits.at(-1)).toEqual(noButtons('✅ Approved — run_command'));
      expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited', attempts: 2 });
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a tap on a settled request whose card was never recorded adopts the card and settles it', async () => {
    const { approvalId } = await telegramCard();
    await db
      .delete(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, approvalId));
    await db
      .update(approvalRequests)
      .set({ status: 'expired', resolvedAt: new Date(), resolvedBy: 'system:ttl_expired' })
      .where(eq(approvalRequests.id, approvalId));
    fetchMock.mockClear();

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:r`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits).toEqual([noButtons('⌛ Expired — run_command')]);
    expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited', attempts: 1 });
  });

  it('« Always allow? » then « Back » while the dashboard decides: the card ends on the settled text', async () => {
    const { approvalId } = await telegramCard();
    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:w`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });
    expect(completedTelegramEdits.at(-1)?.['text']).toContain('Always allow run_command');
    onNextTelegramEdit = async () => {
      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'approve',
        resolvedBy: 'api',
      });
    };

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:wb`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits.at(-1)).toEqual(noButtons('✅ Approved — run_command'));
    expect(await cardRow(approvalId)).toMatchObject({ outcome: 'edited' });
  });

  it('« Back » on a request without entity (« Still pending ») while the dashboard decides: the card ends on the settled text', async () => {
    const { approvalId } = await telegramCard();
    await db
      .update(approvalRequests)
      .set({ entityId: null })
      .where(eq(approvalRequests.id, approvalId));
    onNextTelegramEdit = async (body) => {
      expect(body['text']).toBe('⏳ Still pending — run_command. Resolve it from the dashboard.');
      await resolveApprovalDecision(deps, testEnv, {
        approvalRequestId: approvalId,
        decision: 'reject',
        resolvedBy: 'api',
      });
    };

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:wb`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits.at(-1)).toEqual(noButtons('❌ Rejected — run_command'));
  });

  it('a confirmation tap on a request already closed never puts buttons back', async () => {
    const { approvalId } = await telegramCard();
    await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: approvalId,
      decision: 'reject',
      resolvedBy: 'api',
    });
    completedTelegramEdits.length = 0;

    await handleApprovalCallback({
      update: tap(`apr:${approvalId}:w`),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
      env: testEnv,
    });

    expect(completedTelegramEdits).toEqual([noButtons('❌ Rejected — run_command')]);
  });

  it('showApprovalCard on a request already closed never writes the asked view — only the settled text', async () => {
    const { approvalId } = await telegramCard();
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'api' })
      .where(eq(approvalRequests.id, approvalId));
    completedTelegramEdits.length = 0;

    const shown = await showApprovalCard(
      deps.db,
      {
        approvalRequestId: approvalId,
        channel: 'telegram',
        agentId: seed.agentId,
        conversationId: OWNER_CHAT,
        messageId: String(TELEGRAM_CARD_MESSAGE_ID),
      },
      { text: 'Sure?', buttons: [[{ label: 'Yes', callbackData: `apr:${approvalId}:wc` }]] },
    );

    expect(shown).toEqual({ outcome: 'settled' });
    expect(completedTelegramEdits).toEqual([noButtons('✅ Approved — run_command')]);
  });
});
