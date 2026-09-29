// stop-command.test.ts — `/stop` sur un canal est traité par la PLATEFORME,
// jamais par un modèle (#602).
//
// Le 28/09, trois « Arrête !!! » envoyés sur Telegram ont chacun créé un job
// neuf, qui a répondu « rien ne tourne » pendant qu'un délégué ComfyArtist
// continuait deux heures. #575 a donné au job de tête des outils pour voir et
// arrêter les runs de sa conversation, mais c'est au modèle de choisir de les
// appeler : un modèle dégénéré ne le fait pas, et un job Claude Code ou Codex
// n'a aucun outil Nodal.
//
// Ici, on envoie `/stop` par les handlers RÉELS des quatre canaux, et on lit
// les lignes en base : la tête et son délégué sont `cancelled`, l'approbation
// en attente est `expired`, aucun job n'est né, et une autre conversation du
// même canal n'a pas bougé.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  approvalRequests,
  channelAllowedConversations,
  conversations,
  telegramAllowedChats,
  and,
  eq,
  inArray,
} from '@nodal-agents/db';
import type { TelegramUpdate, WhatsAppInboundMessage } from '@nodal-agents/delivery';
import { handleTelegramUpdate } from '../../telegram/handler.ts';
import { handleDiscordMessage } from '../../channels/discord/handler.ts';
import { handleSlackMessage } from '../../channels/slack/handler.ts';
import { handleWhatsAppMessage } from '../../channels/whatsapp/handler.ts';
import { parseStopCommand, type ChannelStopResult } from '../../channels/turn.ts';
import type { RunnerDeps } from '../../deps.ts';

let db: TestDb;
let entityId: string;
let agentId: string;
let artistId: string;

const BOT = 'test_bot';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  agentId = seed.agentId;
  const [artist] = await db
    .insert(agents)
    .values({ entityId, name: 'ComfyArtist', slug: `artist-${Date.now()}`, personality: 'Draws.' })
    .returning({ id: agents.id });
  artistId = artist!.id;
});

beforeEach(async () => {
  await db.delete(approvalRequests);
  await db.delete(agentJobs);
  await db.delete(conversations);
});

type Channel = 'telegram' | 'discord' | 'slack' | 'whatsapp';

/** Ce que chaque handler rend et qui compte ici : le job né, l'arrêt, le refus. */
interface Outcome {
  jobId?: string;
  stop?: ChannelStopResult;
  skipped?: string;
}

const tx = () => db as unknown as RunnerDeps['db'];

/** Un message privé `text` sur `channel`, dans le fil `chatId`, par le handler réel du canal. */
async function send(channel: Channel, chatId: string, text: string): Promise<Outcome> {
  switch (channel) {
    case 'telegram': {
      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: Number(chatId), type: 'private' },
          from: { id: 7, first_name: 'Alice', is_bot: false },
          text,
        },
      };
      return handleTelegramUpdate({
        update,
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUsername: BOT,
        tx: tx(),
      });
    }
    case 'discord':
      return handleDiscordMessage({
        message: {
          channelId: chatId,
          channelType: 'dm',
          content: text,
          author: { id: 'u1', bot: false, username: 'alice', globalName: 'Alice' },
          mentionedUserIds: [],
          attachments: [],
        },
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUserId: 'bot-1',
        tx: tx(),
      });
    case 'slack':
      return handleSlackMessage({
        message: {
          conversationId: chatId,
          channelType: 'im',
          text,
          user: { id: 'U1', bot: false, displayName: 'Alice' },
        },
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUserId: 'UBOT',
        tx: tx(),
      });
    case 'whatsapp': {
      const message: WhatsAppInboundMessage = {
        conversationId: chatId,
        senderJid: chatId,
        senderName: 'Alice',
        text,
        timestamp: 0,
        isGroup: false,
        mentionsSelf: false,
      };
      return handleWhatsAppMessage({
        message,
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        tx: tx(),
      });
    }
  }
}

/** Autorise `chatId` sur `channel`, comme l'a fait un propriétaire (membre actif). */
async function allow(channel: Channel, chatId: string): Promise<void> {
  if (channel === 'telegram') {
    await db
      .insert(telegramAllowedChats)
      .values({ entityId, agentId, chatId, role: 'member', status: 'active' })
      .onConflictDoNothing();
    return;
  }
  await db
    .insert(channelAllowedConversations)
    .values({
      entityId,
      agentId,
      channel,
      conversationId: chatId,
      kind: 'private',
      role: 'member',
      status: 'active',
    })
    .onConflictDoNothing();
}

let seq = 0;
/** Un identifiant de fil propre au canal (Telegram veut un nombre). */
function chat(channel: Channel): string {
  seq += 1;
  return channel === 'telegram' ? String(900_000 + seq) : `${channel}-chat-${seq}`;
}

/**
 * Un fil de `channel` en plein travail : la conversation courante porte un run
 * dont la tête attend son délégué, lequel tourne et attend une approbation.
 */
async function busyThread(channel: Channel, chatId: string) {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId, agentId, channel, chatId, title: 'Portrait' })
    .returning({ id: conversations.id });
  const conversationId = conv!.id;
  const [head] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel,
      chatId,
      conversationId,
      status: 'awaiting_delegation',
      task: 'Fais-moi un portrait',
    })
    .returning({ id: agentJobs.id });
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId: artistId,
      channel,
      chatId,
      conversationId,
      parentJobId: head!.id,
      status: 'processing',
      task: 'Generate the portrait with ComfyUI',
    })
    .returning({ id: agentJobs.id });
  const [approval] = await db
    .insert(approvalRequests)
    .values({
      entityId,
      jobId: child!.id,
      agentId: artistId,
      toolName: 'run_command',
      toolInput: { command: 'python main.py' },
      kind: 'approval',
    })
    .returning({ id: approvalRequests.id });
  return { conversationId, head: head!.id, child: child!.id, approval: approval!.id };
}

async function statusOf(ids: string[]): Promise<Record<string, string | null>> {
  const rows = await db
    .select({ id: agentJobs.id, status: agentJobs.status })
    .from(agentJobs)
    .where(inArray(agentJobs.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

async function requestStatus(id: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id));
  return row?.status;
}

async function jobsOf(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(and(eq(agentJobs.entityId, entityId), eq(agentJobs.conversationId, conversationId)));
  return rows.map((r) => r.id).sort();
}

const CHANNELS: Channel[] = ['telegram', 'discord', 'slack', 'whatsapp'];

describe('/stop from a channel ends every run of the conversation, without a model @cap:parler-par-canal-externe/moteur', () => {
  describe.each(CHANNELS)('on %s', (channel) => {
    it('cancels the root run and its live delegate, closes the pending approval, creates no job, and leaves another conversation of the same channel running', async () => {
      const chatId = chat(channel);
      const otherChatId = chat(channel);
      await allow(channel, chatId);
      await allow(channel, otherChatId);
      const busy = await busyThread(channel, chatId);
      const other = await busyThread(channel, otherChatId);
      const jobsBefore = await jobsOf(busy.conversationId);

      const result = await send(channel, chatId, '/stop');

      expect(result.jobId).toBeUndefined();
      expect(result.stop?.conversationId).toBe(busy.conversationId);
      expect(result.stop?.stopped.map((r) => r.runId)).toEqual([busy.head]);
      expect([...(result.stop?.stopped[0]?.jobIds ?? [])].sort()).toEqual(
        [busy.head, busy.child].sort(),
      );
      expect(result.stop?.stopped[0]?.requestIds).toEqual([busy.approval]);

      expect(await statusOf([busy.head, busy.child])).toEqual({
        [busy.head]: 'cancelled',
        [busy.child]: 'cancelled',
      });
      expect(await requestStatus(busy.approval)).toBe('expired');
      // Aucun job n'est né : la commande n'est pas un tour de la conversation.
      expect(await jobsOf(busy.conversationId)).toEqual(jobsBefore);

      // L'autre conversation du même canal tourne toujours.
      expect(await statusOf([other.head, other.child])).toEqual({
        [other.head]: 'awaiting_delegation',
        [other.child]: 'processing',
      });
      expect(await requestStatus(other.approval)).toBe('pending');
    });

    it('stops nothing when the sender is not authorized on this channel', async () => {
      const chatId = chat(channel);
      const strangerChatId = chat(channel);
      await allow(channel, chatId);
      const busy = await busyThread(channel, chatId);

      // Un inconnu, sur un fil qui n'est pas autorisé : la même règle que pour
      // lancer un job le retient avant toute lecture de la conversation.
      const result = await send(channel, strangerChatId, '/stop');

      expect(result.stop).toBeUndefined();
      expect(result.jobId).toBeUndefined();
      expect(result.skipped).toBe('awaiting_authorization');
      expect(await statusOf([busy.head, busy.child])).toEqual({
        [busy.head]: 'awaiting_delegation',
        [busy.child]: 'processing',
      });
      expect(await requestStatus(busy.approval)).toBe('pending');
    });

    it('on a thread with nothing running: stops nothing, creates no job and no conversation', async () => {
      const chatId = chat(channel);
      await allow(channel, chatId);

      const result = await send(channel, chatId, '/stop');

      expect(result.jobId).toBeUndefined();
      expect(result.stop).toEqual({ conversationId: null, stopped: [], alreadyFinished: [] });
      const convs = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.channel, channel), eq(conversations.chatId, chatId)));
      expect(convs).toEqual([]);
    });

    it('a sentence that starts with /stop is a message for the agent, not the command', async () => {
      const chatId = chat(channel);
      await allow(channel, chatId);
      const busy = await busyThread(channel, chatId);

      const result = await send(channel, chatId, '/stop the music please');

      expect(result.stop).toBeUndefined();
      expect(result.jobId).toBeDefined();
      expect(await statusOf([busy.head, busy.child])).toEqual({
        [busy.head]: 'awaiting_delegation',
        [busy.child]: 'processing',
      });
    });
  });

  describe('on a Telegram group', () => {
    function groupUpdate(text: string, chatId: number): TelegramUpdate {
      return {
        update_id: 1,
        message: {
          message_id: 43,
          chat: { id: chatId, type: 'supergroup' },
          from: { id: 7, first_name: 'Alice', is_bot: false },
          text,
        },
      };
    }

    it('`/stop@<this bot>` — what the command menu sends in a group — stops the conversation', async () => {
      const chatId = '-100777';
      await allow('telegram', chatId);
      const busy = await busyThread('telegram', chatId);

      const result = await handleTelegramUpdate({
        update: groupUpdate(`/stop@${BOT}`, Number(chatId)),
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUsername: BOT,
        tx: tx(),
      });

      expect(result.jobId).toBeUndefined();
      expect(result.stop?.stopped.map((r) => r.runId)).toEqual([busy.head]);
      expect(await statusOf([busy.head, busy.child])).toEqual({
        [busy.head]: 'cancelled',
        [busy.child]: 'cancelled',
      });
    });

    it('a bare `/stop` in a group passes the group filter, like `/new`', async () => {
      const chatId = '-100778';
      await allow('telegram', chatId);
      const busy = await busyThread('telegram', chatId);

      const result = await handleTelegramUpdate({
        update: groupUpdate('/stop', Number(chatId)),
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUsername: BOT,
        tx: tx(),
      });

      expect(result.stop?.stopped.map((r) => r.runId)).toEqual([busy.head]);
    });

    it('`/stop@<another bot>` is not for this bot: nothing stops', async () => {
      const chatId = '-100779';
      await allow('telegram', chatId);
      const busy = await busyThread('telegram', chatId);

      const result = await handleTelegramUpdate({
        update: groupUpdate('/stop@someone_else_bot', Number(chatId)),
        receivingAgentId: agentId,
        receivingAgentEntityId: entityId,
        receivingAgentBotUsername: BOT,
        tx: tx(),
      });

      expect(result.stop).toBeUndefined();
      expect(result.skipped).toBe('group_filter');
      expect(await statusOf([busy.head])).toEqual({ [busy.head]: 'awaiting_delegation' });
    });
  });
});

describe('parseStopCommand', () => {
  it('is the command alone, optionally addressed to this bot', () => {
    expect(parseStopCommand('/stop', null)).toBe(true);
    expect(parseStopCommand('  /stop  ', null)).toBe(true);
    expect(parseStopCommand('/STOP', null)).toBe(true);
    expect(parseStopCommand('/stop@Test_Bot', 'test_bot')).toBe(true);
    expect(parseStopCommand('/stop@other_bot', 'test_bot')).toBe(false);
    expect(parseStopCommand('/stop@test_bot', null)).toBe(false);
    expect(parseStopCommand('/stop now', null)).toBe(false);
    expect(parseStopCommand('/stopwatch', null)).toBe(false);
    expect(parseStopCommand('please /stop', null)).toBe(false);
  });
});
