// tests/delivery/resolve-delivery-target.test.ts
//
// Ce que ces tests prouvent :
//   - `agent_jobs.channel` est une ORIGINE : un job 'cron' ne « livre » jamais
//     sur un canal 'cron', il est résolu vers un vrai transport ;
//   - un déclencheur cron/webhook qui a CHOISI son canal de notification
//     l'emporte sur l'ordre de priorité par défaut ;
//   - les deux refus sont rendus par leur nom, jamais par un `null` muet.
//
// Aucun mock : `listActiveChannelsForAgent` et `resolveTransportChannel` sont
// les vraies fonctions, sur une vraie base PGlite. Un mock du résolveur de
// canal ne prouverait que le mock.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agents, channelBindings, encryptChannelCredentials } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  resolveDeliveryTarget,
  isDeliveryRefusal,
} from '../../delivery/resolve-delivery-target.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

/** Rend l'agent joignable sur Telegram (le token scalaire historique). */
async function giveTelegramBinding(): Promise<void> {
  await db
    .update(agents)
    .set({ telegramBotToken: 'test-telegram-token' })
    .where(eq(agents.id, seed.agentId));
}

async function clearChannels(): Promise<void> {
  await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  await db.delete(channelBindings).where(eq(channelBindings.agentId, seed.agentId));
}

async function giveDiscordBinding(): Promise<void> {
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'discord',
    credentials: encryptChannelCredentials({ botToken: 'test-discord-token' }),
    enabled: true,
  });
}

describe('resolveDeliveryTarget', () => {
  it("agent_jobs.channel='cron' ⇒ transport résolu, jamais 'cron'", async () => {
    await clearChannels();
    await giveTelegramBinding();

    const outcome = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: 'chat-cron-1',
      agentId: seed.agentId,
      channel: 'cron',
      triggerContext: null,
    });

    expect(isDeliveryRefusal(outcome)).toBe(false);
    if (isDeliveryRefusal(outcome)) return;
    expect(outcome.channel).toBe('telegram');
    // La valeur d'origine ne doit JAMAIS ressortir comme canal de transport :
    // 'cron' ne sait pas recevoir de message, et la table le refuserait.
    expect(outcome.channel).not.toBe('cron');
    expect(outcome.chatId).toBe('chat-cron-1');
  });

  it('override notifyChannel cron : le canal choisi par le déclencheur gagne', async () => {
    await clearChannels();
    await giveTelegramBinding();
    await giveDiscordBinding();

    const outcome = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: 'chat-cron-2',
      agentId: seed.agentId,
      channel: 'cron',
      // Telegram est premier dans l'ordre de priorité ET actif : sans
      // l'override, ce job partirait sur Telegram.
      triggerContext: { type: 'cron', notifyChannel: 'discord' },
    });

    expect(isDeliveryRefusal(outcome)).toBe(false);
    if (isDeliveryRefusal(outcome)) return;
    expect(outcome.channel).toBe('discord');
  });

  it("un job déjà sur un transport garde le sien, l'override absent", async () => {
    await clearChannels();
    await giveTelegramBinding();
    await giveDiscordBinding();

    const outcome = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: 'chat-discord-1',
      agentId: seed.agentId,
      channel: 'discord',
      triggerContext: null,
    });

    expect(isDeliveryRefusal(outcome)).toBe(false);
    if (isDeliveryRefusal(outcome)) return;
    expect(outcome.channel).toBe('discord');
  });

  it('pas de chat ⇒ refus no_chat, jamais une cible inventée', async () => {
    await clearChannels();
    await giveTelegramBinding();

    const noChat = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: null,
      agentId: seed.agentId,
      channel: 'cron',
      triggerContext: null,
    });
    expect(noChat).toEqual({ refused: 'no_chat' });

    // Une chaîne d'espaces n'est pas un chat non plus.
    const blankChat = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: '   ',
      agentId: seed.agentId,
      channel: 'cron',
      triggerContext: null,
    });
    expect(blankChat).toEqual({ refused: 'no_chat' });
  });

  it('aucun canal actif ⇒ refus channel_inactive', async () => {
    await clearChannels();

    const outcome = await resolveDeliveryTarget(db as unknown as AnyDrizzleDb, {
      chatId: 'chat-orphan',
      agentId: seed.agentId,
      channel: 'cron',
      triggerContext: null,
    });

    expect(outcome).toEqual({ refused: 'channel_inactive' });
  });
});
