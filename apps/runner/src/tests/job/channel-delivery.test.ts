// channel-delivery.test.ts — les faits du canal que le prompt porte (#613).
//
// Le prompt d'un job sur canal portait 6 300 caractères écrits à la main pour
// Telegram, dont trois consignes que le runner contredit. Il n'en reste qu'une
// ligne, posée exactement là où la garde de livraison exige un envoi par outil,
// avec le canal que l'outil résoudra et ce que SON adaptateur fait du texte.

import { describe, it, expect } from 'vitest';
import { getAdapter, telegramAdapter, discordAdapter, slackAdapter } from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import { channelDeliveryFacts, TOOL_ONLY_DELIVERY_CHANNELS } from '../../job/channel-delivery.ts';

const facts = (
  job: { channel: string | null; chatId: string | null },
  extra: { notifyChannelOverride?: ChannelKind; activeChannels?: ChannelKind[] } = {},
) =>
  channelDeliveryFacts({
    job,
    notifyChannelOverride: extra.notifyChannelOverride,
    activeChannels: extra.activeChannels ?? [],
  });

describe('channelDeliveryFacts — the channel line comes from the adapter (#613) @cap:parler-par-canal-externe/moteur', () => {
  it('a Telegram job: no mark renders, through the send tool', () => {
    expect(facts({ channel: 'telegram', chatId: '199791464' })).toEqual({
      channel: 'telegram',
      sendTool: 'telegram_send_message',
      renders: telegramAdapter.text.renders,
      onlyPath: true,
    });
  });

  it('a Discord job: the marks Discord renders — its own adapter, not Telegram rules', () => {
    expect(facts({ channel: 'discord', chatId: '1511202553420054671' })).toEqual({
      channel: 'discord',
      sendTool: 'telegram_send_message',
      renders: discordAdapter.text.renders,
      onlyPath: true,
    });
  });

  it('every tool-delivery channel states what ITS adapter declares', () => {
    for (const channel of TOOL_ONLY_DELIVERY_CHANNELS) {
      const f = facts({ channel, chatId: '1' });
      expect({ channel, renders: f?.renders, onlyPath: f?.onlyPath }).toEqual({
        channel,
        renders: getAdapter(channel as ChannelKind).text.renders,
        onlyPath: true,
      });
    }
  });

  it('a routine that asked for a confirmation gets the facts of the channel the tool will reach', () => {
    // An explicit notify channel wins, as in delivery-guard's defaultChannelForJob.
    expect(facts({ channel: 'cron', chatId: '1' }, { notifyChannelOverride: 'slack' })).toEqual({
      channel: 'slack',
      sendTool: 'telegram_send_message',
      renders: slackAdapter.text.renders,
      onlyPath: true,
    });
    // Left on auto: the agent's first active channel, by the same rule.
    expect(facts({ channel: 'webhook', chatId: '1' }, { activeChannels: ['discord'] })).toEqual({
      channel: 'discord',
      sendTool: 'telegram_send_message',
      renders: discordAdapter.text.renders,
      onlyPath: true,
    });
  });

  it('where the reply does not go through a tool, the format fact stays and the tool is not the only path', () => {
    // A dashboard job of an agent that has a Telegram bot: the send tool is
    // armed (execute.ts gates it on the credential), the dashboard reads the
    // result. What the tool does with a text is still true.
    expect(facts({ channel: 'dashboard', chatId: null }, { activeChannels: ['telegram'] })).toEqual(
      {
        channel: 'telegram',
        sendTool: 'telegram_send_message',
        renders: telegramAdapter.text.renders,
        onlyPath: false,
      },
    );
    // A delegate inherits its parent's chat_id; its reply goes to the parent.
    // Whether it holds the tool is the prompt's filter (system-prompt.test.ts).
    expect(facts({ channel: 'internal', chatId: '199791464' })?.onlyPath).toBe(false);
    // A routine that asked for no confirmation.
    expect(facts({ channel: 'cron', chatId: null }, { activeChannels: ['slack'] })?.onlyPath).toBe(
      false,
    );
  });

  it('no facts for a channel that has no send tool (WhatsApp today)', () => {
    expect(facts({ channel: 'whatsapp', chatId: '111@s.whatsapp.net' })).toBeUndefined();
  });
});
