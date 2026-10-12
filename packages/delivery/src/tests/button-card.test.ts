// button-card.test.ts — une carte à boutons LIBRES (`sendCard`) et sa
// réécriture avec boutons (`editMessageText`), sur les trois canaux qui savent
// en porter. C'est ce qu'il faut à un formulaire rempli geste par geste depuis
// un canal (la question d'un serveur MCP, 0145) : chaque geste réécrit la même
// carte, boutons compris.
//
// Ce qui est relu : le corps exact envoyé à chaque API (inline_keyboard,
// components, blocks) — ce que le canal affichera.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REST, Routes } from 'discord.js';
import type { APIMessage } from 'discord.js';
import { WebClient, type ChatPostMessageResponse } from '@slack/web-api';
import { telegramAdapter } from '../channels/telegram-adapter.ts';
import { discordAdapter } from '../channels/discord-adapter.ts';
import { slackAdapter } from '../channels/slack-adapter.ts';

const ROWS = [
  [
    { label: 'Color: Full color', callbackData: 'eli:x:c.0.0' },
    { label: '✓ Color: Grayscale', callbackData: 'eli:x:c.0.1' },
  ],
  [
    { label: '✅ Send', callbackData: 'eli:x:s.abcdef12' },
    { label: '❌ Decline', callbackData: 'eli:x:d' },
  ],
];

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch');
  vi.spyOn(REST.prototype, 'post');
  vi.spyOn(REST.prototype, 'patch');
  vi.spyOn(WebClient.prototype, 'apiCall');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Telegram : carte à boutons libres @cap:approuver-une-action/moteur', () => {
  it('sendCard pose le clavier tel quel, une rangée par rangée', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 }),
    );
    const r = await telegramAdapter.sendCard!({ botToken: 'T' }, '42', {
      text: 'Q?',
      buttons: ROWS,
    });
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['text']).toBe('Q?');
    expect(body['reply_markup']).toEqual({
      inline_keyboard: ROWS.map((row) =>
        row.map((b) => ({ text: b.label, callback_data: b.callbackData })),
      ),
    });
    expect(r).toEqual({ messageId: '9' });
  });
});

describe('Discord : carte à boutons libres @cap:approuver-une-action/moteur', () => {
  it('déclare ce qu’elle peut porter : 5 rangées de 5', () => {
    expect(discordAdapter.capabilities.buttonLimits).toEqual({ maxRows: 5, maxPerRow: 5 });
  });

  it('sendCard pose une rangée de composants par rangée', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce({ id: '77' } as APIMessage);
    const r = await discordAdapter.sendCard!({ botToken: 'D' }, '123', {
      text: 'Q?',
      buttons: ROWS,
    });
    const [route, options] = vi.mocked(REST.prototype.post).mock.calls[0]!;
    expect(route).toBe(Routes.channelMessages('123'));
    const body = options?.body as { content: string; components: unknown[] };
    expect(body.content).toBe('Q?');
    expect(body.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Color: Full color', custom_id: 'eli:x:c.0.0' },
          { type: 2, style: 2, label: '✓ Color: Grayscale', custom_id: 'eli:x:c.0.1' },
        ],
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: '✅ Send', custom_id: 'eli:x:s.abcdef12' },
          { type: 2, style: 2, label: '❌ Decline', custom_id: 'eli:x:d' },
        ],
      },
    ]);
    expect(r).toEqual({ messageId: '77' });
  });

  it('editMessageText réécrit la carte AVEC ses boutons', async () => {
    vi.mocked(REST.prototype.patch).mockResolvedValueOnce({} as APIMessage);
    const r = await discordAdapter.editMessageText!({ botToken: 'D' }, '123', '77', 'Q2', ROWS);
    expect(r).toEqual({ ok: true });
    const body = vi.mocked(REST.prototype.patch).mock.calls[0]![1]?.body as {
      content: string;
      components: Array<{ components: unknown[] }>;
    };
    expect(body.content).toBe('Q2');
    expect(body.components).toHaveLength(2);
    expect(body.components[1]!.components).toHaveLength(2);
  });

  it('une carte au-delà de ce que Discord porte est refusée, jamais coupée', async () => {
    const tooMany = Array.from({ length: 6 }, () => [ROWS[0]![0]!]);
    await expect(
      discordAdapter.sendCard!({ botToken: 'D' }, '123', { text: 'Q?', buttons: tooMany }),
    ).rejects.toThrow(/6 rows of buttons.*at most 5/);
    expect(vi.mocked(REST.prototype.post).mock.calls).toEqual([]);
  });
});

describe('Slack : carte à boutons libres @cap:approuver-une-action/moteur', () => {
  it('sendCard pose un bloc d’actions par rangée sous le texte', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      ts: '1.5',
    } as ChatPostMessageResponse);
    const r = await slackAdapter.sendCard!({ botToken: 'S' }, 'D1', { text: 'Q?', buttons: ROWS });
    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.postMessage');
    expect(options).toMatchObject({
      channel: 'D1',
      text: 'Q?',
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: 'Q?', emoji: true } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Color: Full color' },
              action_id: 'eli:x:c.0.0',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✓ Color: Grayscale' },
              action_id: 'eli:x:c.0.1',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Send' },
              action_id: 'eli:x:s.abcdef12',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Decline' },
              action_id: 'eli:x:d',
            },
          ],
        },
      ],
    });
    expect(r).toEqual({ messageId: '1.5' });
  });

  it('editMessageText réécrit la carte AVEC ses boutons', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({ ok: true });
    const r = await slackAdapter.editMessageText!({ botToken: 'S' }, 'D1', '1.5', 'Q2', ROWS);
    expect(r).toEqual({ ok: true });
    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.update');
    const blocks = (options as { blocks: Array<{ type: string }> }).blocks;
    expect(blocks.map((b) => b.type)).toEqual(['section', 'actions', 'actions']);
  });
});

// Revue de #664, passe 3 : le texte d'une carte à boutons porte les mots d'un
// tiers (la question d'un serveur MCP). Aucun canal ne le met en forme ni ne
// le laisse notifier quelqu'un.
describe('le texte d’une carte à boutons ne notifie personne @cap:approuver-une-action/moteur', () => {
  it('Discord : aucune mention ne pinge, utilisateurs compris', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce({ id: '78' } as APIMessage);
    await discordAdapter.sendCard!({ botToken: 'D' }, '123', {
      text: 'Hi <@123456789012345678> @everyone',
      buttons: ROWS,
    });
    const body = vi.mocked(REST.prototype.post).mock.calls[0]![1]?.body as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('Slack : le texte part en plain_text, jamais en mrkdwn', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      ts: '1.6',
    } as ChatPostMessageResponse);
    await slackAdapter.sendCard!({ botToken: 'S' }, 'D1', {
      text: '<!channel> *now*',
      buttons: ROWS,
    });
    const blocks = (
      vi.mocked(WebClient.prototype.apiCall).mock.calls[0]![1] as {
        blocks: Array<{ type: string; text?: { type: string; text: string } }>;
      }
    ).blocks;
    expect(blocks[0]).toEqual({
      type: 'section',
      text: { type: 'plain_text', text: '<!channel> *now*', emoji: true },
    });
  });

  it('Telegram déclare ce que son clavier porte : 100 boutons, 8 par rangée', () => {
    expect(telegramAdapter.capabilities.buttonLimits).toEqual({
      maxRows: 100,
      maxPerRow: 8,
      maxButtons: 100,
    });
  });
});

// Review of #664, pass 4: every redraw of a card went out with
// allowed_mentions parse [users]: a <@id> in the server's question pinged on
// each gesture. An edit notifies nobody, like the card it rewrites.
describe('Discord : une réécriture de carte ne notifie personne @cap:approuver-une-action/moteur', () => {
  it('editMessageText : aucune mention ne pinge', async () => {
    vi.mocked(REST.prototype.patch).mockResolvedValueOnce({} as APIMessage);
    await discordAdapter.editMessageText!(
      { botToken: 'D' },
      '123',
      '77',
      'Hi <@123456789012345678>',
      ROWS,
    );
    const body = vi.mocked(REST.prototype.patch).mock.calls[0]![1]?.body as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});

// Review of #664, pass 4: the plain_text test only read `blocks`. Slack also
// sends `text` (notifications, fallback), where <!channel> and <@U…> are
// live. A card's `text` is escaped, on send and on every redraw.
describe('Slack : le texte de repli d’une carte est neutralisé @cap:approuver-une-action/moteur', () => {
  it('sendCard et editMessageText échappent < > & dans `text`', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      ts: '1.7',
    } as ChatPostMessageResponse);
    await slackAdapter.sendCard!({ botToken: 'S' }, 'D1', {
      text: '<!channel> <@U1> & co',
      buttons: ROWS,
    });
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({ ok: true });
    await slackAdapter.editMessageText!({ botToken: 'S' }, 'D1', '1.7', '<!here> again', ROWS);
    const [sent, edited] = vi.mocked(WebClient.prototype.apiCall).mock.calls;
    expect((sent![1] as { text: string }).text).toBe('&lt;!channel&gt; &lt;@U1&gt; &amp; co');
    expect((edited![1] as { text: string }).text).toBe('&lt;!here&gt; again');
  });
});
