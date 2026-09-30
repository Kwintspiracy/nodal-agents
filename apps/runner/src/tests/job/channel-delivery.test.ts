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
  designatedChatChannel,
  replyDestination,
  TOOL_ONLY_DELIVERY_CHANNELS,
} from '../../job/channel-delivery.ts';

// An agent that holds every channel's credential and the send tool, unless a
// case says otherwise.
const ALL_ACTIVE: ChannelKind[] = ['telegram', 'discord', 'slack'];
const HOLDS_SEND = new Set(['telegram_send_message']);

const facts = (
  job: { channel: string | null; chatId: string | null; parentJobId?: string | null },
  extra: { chatChannel?: ChannelKind; activeChannels?: ChannelKind[] } = {},
) =>
  channelDeliveryFacts({
    job: { parentJobId: null, ...job },
    chatChannel: extra.chatChannel,
    activeChannels: extra.activeChannels ?? ALL_ACTIVE,
    heldTools: HOLDS_SEND,
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
    expect(facts({ channel: 'cron', chatId: '1' }, { chatChannel: 'slack' })).toEqual({
      channel: 'slack',
      sendTool: 'telegram_send_message',
      renders: slackAdapter.text.renders,
      reply: 'channel',
    });
    // A webhook left on auto records the channel its route resolved.
    expect(facts({ channel: 'webhook', chatId: '1' }, { chatChannel: 'discord' })).toEqual({
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
    extra: {
      chatChannel?: ChannelKind;
      activeChannels?: readonly ChannelKind[];
      heldTools?: ReadonlySet<string>;
    } = {},
  ) =>
    replyDestination({
      job: { parentJobId: null, ...job },
      chatChannel: extra.chatChannel,
      activeChannels: extra.activeChannels ?? ALL_ACTIVE,
      heldTools: extra.heldTools ?? HOLDS_SEND,
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
    expect(dest({ channel: 'cron', chatId: '1' }, { chatChannel: 'slack' })).toEqual({
      to: 'channel',
      channel: 'slack',
    });
    expect(dest({ channel: 'webhook', chatId: '1' }, { chatChannel: 'discord' })).toEqual({
      to: 'channel',
      channel: 'discord',
    });
    expect(
      dest({ channel: 'dashboard', chatId: '199791464' }, { chatChannel: 'telegram' }),
    ).toEqual({ to: 'channel', channel: 'telegram' });
  });

  // Revue passe 2 de #657 (bloquant) : « armé » validait le canal de REPLI
  // (premier canal actif), pas celui du chat désigné. « Send via Telegram »
  // ou un cron auto, jeton Telegram retiré, Discord actif : la réponse partait
  // sur Discord avec un chat id Telegram, et se perdait.
  it('a named chat is reached on ITS channel only: a Telegram chat with the token withdrawn and Discord active is answered by the result', () => {
    for (const channel of ['dashboard', 'cron', 'webhook', 'api']) {
      for (const activeChannels of [
        ['discord'],
        ['slack'],
        ['discord', 'slack'],
      ] as ChannelKind[][]) {
        expect({
          channel,
          activeChannels,
          to: dest({ channel, chatId: '199791464' }, { chatChannel: 'telegram', activeChannels }),
        }).toEqual({ channel, activeChannels, to: { to: 'result' } });
      }
    }
  });

  it('a named chat whose channel nobody recorded is never guessed: the origin reads the result', () => {
    for (const channel of ['dashboard', 'api', 'cron']) {
      expect({ channel, to: dest({ channel, chatId: '199791464' }) }).toEqual({
        channel,
        to: { to: 'result' },
      });
    }
  });

  it('a delegate answers its parent, even carrying the chat it inherited', () => {
    expect(dest({ channel: 'internal', chatId: '199791464', parentJobId: 'p' })).toEqual({
      to: 'parent',
    });
  });

  it('a chat on a channel with no send tool is not a tool destination (WhatsApp today)', () => {
    expect(dest({ channel: 'whatsapp', chatId: '111@s.whatsapp.net' })).toEqual({ to: 'result' });
  });

  // Revue passe 1 de #657 : une tâche dashboard « Send via Telegram » dont
  // l'agent n'a plus de jeton retombait sur 'telegram' par défaut, donc
  // 'channel', alors qu'aucun outil d'envoi n'était armé : la garde faisait
  // échouer un travail fait. Un chat qu'aucun outil armé n'atteint n'est pas
  // une destination.
  it('a chat named by the trigger that no armed send tool can reach: the origin reads the result', () => {
    const cases: Array<{
      job: { channel: string; chatId: string };
      extra: Parameters<typeof dest>[1];
    }> = [
      // Credential withdrawn: no channel active at all.
      {
        job: { channel: 'dashboard', chatId: '199791464' },
        extra: { chatChannel: 'telegram', activeChannels: [] },
      },
      {
        job: { channel: 'api', chatId: '199791464' },
        extra: { chatChannel: 'telegram', activeChannels: [] },
      },
      {
        job: { channel: 'cron', chatId: '1' },
        extra: { chatChannel: 'telegram', activeChannels: [] },
      },
      // The routine named Slack, the agent has no enabled Slack binding.
      {
        job: { channel: 'cron', chatId: '1' },
        extra: { chatChannel: 'slack', activeChannels: ['telegram'] },
      },
      // The credential is there, the job does not hold the send tool.
      {
        job: { channel: 'webhook', chatId: '1' },
        extra: { chatChannel: 'telegram', heldTools: new Set<string>() },
      },
      {
        job: { channel: 'dashboard', chatId: '1' },
        extra: { chatChannel: 'telegram', heldTools: new Set<string>() },
      },
    ];
    for (const { job, extra } of cases) {
      expect({ job, to: dest(job, extra) }).toEqual({ job, to: { to: 'result' } });
    }
  });

  it('a request that came FROM a chat stays answered there even with no armed tool: its author reads nothing else, the guard fails loud', () => {
    for (const [job, extra] of [
      [{ channel: 'telegram', chatId: '199791464' }, { activeChannels: [] }],
      [{ channel: 'discord', chatId: '1' }, { heldTools: new Set<string>() }],
    ] as const) {
      expect({ job, to: dest(job, extra) }).toEqual({
        job,
        to: { to: 'channel', channel: job.channel },
      });
    }
  });
});

// Un chat désigné porte son canal, posé là où il est désigné (revue passe 2
// de #657) : jamais déduit du premier canal actif de l'agent.
describe('designatedChatChannel — the channel of a chat the trigger named, as recorded (#649) @cap:parler-par-canal-externe/moteur', () => {
  it('reads the channel recorded with the chat', () => {
    expect(
      designatedChatChannel({
        channel: 'dashboard',
        chatId: '1',
        chatChannel: 'telegram',
        triggerContext: null,
      }),
    ).toBe('telegram');
    expect(
      designatedChatChannel({
        channel: 'api',
        chatId: '1',
        chatChannel: 'slack',
        triggerContext: null,
      }),
    ).toBe('slack');
  });

  it('a routine or webhook row written before the column: the notify channel its trigger recorded', () => {
    expect(
      designatedChatChannel({
        channel: 'cron',
        chatId: '1',
        chatChannel: null,
        triggerContext: {
          type: 'cron',
          scheduleName: 's',
          prevRunAt: null,
          notifyChannel: 'discord',
        },
      }),
    ).toBe('discord');
  });

  it('nothing recorded, no chat, or a request that came FROM a chat: no designated channel', () => {
    expect(
      designatedChatChannel({
        channel: 'dashboard',
        chatId: '1',
        chatChannel: null,
        triggerContext: null,
      }),
    ).toBeUndefined();
    expect(
      designatedChatChannel({
        channel: 'cron',
        chatId: null,
        chatChannel: 'telegram',
        triggerContext: null,
      }),
    ).toBeUndefined();
    expect(
      designatedChatChannel({
        channel: 'telegram',
        chatId: '1',
        chatChannel: null,
        triggerContext: null,
      }),
    ).toBeUndefined();
  });
});
