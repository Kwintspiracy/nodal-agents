// channel-delivery.test.ts — les faits du canal que le prompt porte (#613).
//
// Le prompt d'un job sur canal portait 6 300 caractères écrits à la main pour
// Telegram, dont trois consignes que le runner contredit. Il n'en reste qu'une
// ligne, posée exactement là où la garde de livraison exige un envoi par outil,
// avec le canal que l'outil résoudra et ce que SON adaptateur fait du texte.

import { describe, it, expect } from 'vitest';
import { getAdapter, telegramAdapter, discordAdapter, slackAdapter } from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import {
  channelDeliveryFacts,
  replyDestination,
  TOOL_ONLY_DELIVERY_CHANNELS,
} from '../../job/channel-delivery.ts';

const facts = (
  job: { channel: string | null; chatId: string | null; parentJobId?: string | null },
  extra: { notifyChannelOverride?: ChannelKind; activeChannels?: ChannelKind[] } = {},
) =>
  channelDeliveryFacts({
    job: { parentJobId: null, ...job },
    notifyChannelOverride: extra.notifyChannelOverride,
    activeChannels: extra.activeChannels ?? [],
  });

describe('channelDeliveryFacts — the channel line comes from the adapter (#613) @cap:parler-par-canal-externe/moteur', () => {
  it('a Telegram job: no mark renders, through the send tool', () => {
    expect(facts({ channel: 'telegram', chatId: '199791464' })).toEqual({
      channel: 'telegram',
      sendTool: 'telegram_send_message',
      renders: telegramAdapter.text.renders,
      reply: 'channel',
    });
  });

  it('a Discord job: the marks Discord renders — its own adapter, not Telegram rules', () => {
    expect(facts({ channel: 'discord', chatId: '1511202553420054671' })).toEqual({
      channel: 'discord',
      sendTool: 'telegram_send_message',
      renders: discordAdapter.text.renders,
      reply: 'channel',
    });
  });

  it('every tool-delivery channel states what ITS adapter declares', () => {
    for (const channel of TOOL_ONLY_DELIVERY_CHANNELS) {
      const f = facts({ channel, chatId: '1' });
      expect({ channel, renders: f?.renders, reply: f?.reply }).toEqual({
        channel,
        renders: getAdapter(channel as ChannelKind).text.renders,
        reply: 'channel',
      });
    }
  });

  it('a routine that asked for a confirmation gets the facts of the channel the tool will reach', () => {
    // An explicit notify channel wins, as in delivery-guard's defaultChannelForJob.
    expect(facts({ channel: 'cron', chatId: '1' }, { notifyChannelOverride: 'slack' })).toEqual({
      channel: 'slack',
      sendTool: 'telegram_send_message',
      renders: slackAdapter.text.renders,
      reply: 'channel',
    });
    // Left on auto: the agent's first active channel, by the same rule.
    expect(facts({ channel: 'webhook', chatId: '1' }, { activeChannels: ['discord'] })).toEqual({
      channel: 'discord',
      sendTool: 'telegram_send_message',
      renders: discordAdapter.text.renders,
      reply: 'channel',
    });
  });

  it('where the reply does not go through a tool, the format fact stays and the reply is not the tool', () => {
    // A dashboard job of an agent that has a Telegram bot: the send tool is
    // armed (execute.ts gates it on the credential), the dashboard reads the
    // result. What the tool does with a text is still true.
    expect(facts({ channel: 'dashboard', chatId: null }, { activeChannels: ['telegram'] })).toEqual(
      {
        channel: 'telegram',
        sendTool: 'telegram_send_message',
        renders: telegramAdapter.text.renders,
        reply: 'result',
      },
    );
    // A delegate inherits its parent's chat_id; its reply goes to the parent.
    // Whether it holds the tool is the prompt's filter (system-prompt.test.ts).
    expect(facts({ channel: 'internal', chatId: '199791464', parentJobId: 'p' })?.reply).toBe(
      'parent',
    );
    // A routine that asked for no confirmation.
    expect(facts({ channel: 'cron', chatId: null }, { activeChannels: ['slack'] })?.reply).toBe(
      'result',
    );
  });

  it('no facts for a channel that has no send tool (WhatsApp today)', () => {
    expect(facts({ channel: 'whatsapp', chatId: '111@s.whatsapp.net' })).toBeUndefined();
  });
});

// #649 — une demande arrivée par MCP (`run_task`) : le prompt disait
// « `telegram_send_message` reaches the user on telegram », parce que le canal
// de REPLI d'un job sans transport (resolveTransportChannel) était présenté
// comme le chemin de la réponse. Alfred envoyait la réponse sur le Telegram du
// propriétaire et l'appelant recevait une phrase de narration. La destination
// de la réponse se calcule une fois, d'après l'ORIGINE du job : le repli ne
// sert qu'aux messages que le propriétaire doit recevoir.
describe('replyDestination — the answer goes back where the request came from (#649) @cap:parler-par-canal-externe/moteur', () => {
  const dest = (
    job: { channel: string | null; chatId: string | null; parentJobId?: string | null },
    extra: { notifyChannelOverride?: ChannelKind; activeChannels?: ChannelKind[] } = {},
  ) =>
    replyDestination({
      job: { parentJobId: null, ...job },
      notifyChannelOverride: extra.notifyChannelOverride,
      activeChannels: extra.activeChannels ?? ['telegram'],
    });

  it('a request without a chat is answered by its result, whatever channels the agent has', () => {
    // MCP, API, the web chat, a silent routine: nobody asked for a message.
    for (const channel of ['mcp', 'api', 'dashboard', 'cron', 'webhook', 'internal']) {
      for (const activeChannels of [[], ['telegram'], ['discord', 'slack']] as ChannelKind[][]) {
        expect({
          channel,
          activeChannels,
          to: dest({ channel, chatId: null }, { activeChannels }),
        }).toEqual({ channel, activeChannels, to: { to: 'result' } });
      }
    }
  });

  it('a request that came from a chat is answered in that chat, through the send tool', () => {
    expect(dest({ channel: 'telegram', chatId: '199791464' })).toEqual({
      to: 'channel',
      channel: 'telegram',
    });
    expect(dest({ channel: 'discord', chatId: '1' })).toEqual({
      to: 'channel',
      channel: 'discord',
    });
  });

  it('a request that named a chat to answer on is answered there: routine, webhook, dashboard "send via Telegram"', () => {
    expect(dest({ channel: 'cron', chatId: '1' }, { notifyChannelOverride: 'slack' })).toEqual({
      to: 'channel',
      channel: 'slack',
    });
    expect(dest({ channel: 'webhook', chatId: '1' }, { activeChannels: ['discord'] })).toEqual({
      to: 'channel',
      channel: 'discord',
    });
    expect(dest({ channel: 'dashboard', chatId: '199791464' })).toEqual({
      to: 'channel',
      channel: 'telegram',
    });
  });

  it('a delegate answers its parent, even carrying the chat it inherited', () => {
    expect(dest({ channel: 'internal', chatId: '199791464', parentJobId: 'p' })).toEqual({
      to: 'parent',
    });
  });

  it('a chat on a channel with no send tool is not a tool destination (WhatsApp today)', () => {
    expect(dest({ channel: 'whatsapp', chatId: '111@s.whatsapp.net' })).toEqual({ to: 'result' });
  });
});
