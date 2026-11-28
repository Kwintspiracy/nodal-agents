// outbound-channel.test.ts — what a channel posts leaves through the outbound
// seam: on every channel, what the platform would receive is masked, through
// the adapter every caller resolves (`getAdapter`) and through the senders the
// package index publishes. Identifiers the platform routes by stay intact.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebClient } from '@slack/web-api';
import type { ChatPostMessageResponse } from '@slack/web-api';
import { REST } from 'discord.js';
import type { APIMessage } from 'discord.js';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeBearer, fakeSecret } from '@nodal-agents/test-kit';
import {
  answerTelegramCallback,
  bindDeviceSink,
  editTelegramMessageText,
  getAdapter,
  outboundAdapter,
  sendTelegramMessage,
  sendTelegramPhoto,
  type ChannelAdapter,
  type DeviceOutbound,
} from '../index.ts';
import { outboundWhatsAppHandle } from '../outbound-channel.ts';
import type { WhatsAppHandle } from '../channels/whatsapp/socket-manager.ts';

const { mockEnsureWhatsAppSocket } = vi.hoisted(() => ({ mockEnsureWhatsAppSocket: vi.fn() }));
vi.mock('../channels/whatsapp/socket-manager.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../channels/whatsapp/socket-manager.ts')>()),
  ensureWhatsAppSocket: mockEnsureWhatsAppSocket,
}));

const KEY = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');
const REPLY = `Deployed. I used ${KEY} to push.`;
const MASKED = `Deployed. I used ${REDACTED_TEXT} to push.`;

const telegramOk = (): Response =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Every body the Bot API was sent, parsed. */
function telegramBodies(): Record<string, unknown>[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    );
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => telegramOk());
  vi.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({
    ok: true,
    channel: 'C1',
    ts: '1.1',
  } as ChatPostMessageResponse);
  vi.spyOn(REST.prototype, 'post').mockResolvedValue({ id: '9' } as APIMessage);
});

afterEach(() => {
  vi.restoreAllMocks();
  bindDeviceSink(null);
  mockEnsureWhatsAppSocket.mockReset();
});

describe('every channel posts masked text, through the adapter every caller resolves @cap:parler-par-canal-externe/moteur', () => {
  it('Telegram: the message the Bot API receives', async () => {
    await getAdapter('telegram').sendText({ botToken: '1:x' }, '42', REPLY);
    expect(telegramBodies()[0]?.['text']).toBe(MASKED);
  });

  it('Slack: the message the Web API receives', async () => {
    await getAdapter('slack').sendText({ botToken: 'b', appToken: 'a' }, 'C1', REPLY);
    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.postMessage');
    expect((options as { text?: string }).text).toBe(MASKED);
  });

  it('Discord: the message the REST API receives', async () => {
    await getAdapter('discord').sendText({ botToken: 'b' }, '123', REPLY);
    const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1] as {
      body?: { content?: string };
    };
    expect(options.body?.content).toBe(MASKED);
  });

  it('WhatsApp: the content the socket sends', async () => {
    const send = vi.fn().mockResolvedValue('wamsg-1');
    mockEnsureWhatsAppSocket.mockReturnValue({
      bindingKey: '/s',
      events: new EventEmitter(),
      getStatus: () => 'open',
      getIdentity: () => null,
      send,
      listGroups: vi.fn().mockResolvedValue([]),
    });
    await getAdapter('whatsapp').sendText({ sessionDir: '/s' }, '111@s.whatsapp.net', REPLY);
    expect(send.mock.calls[0]?.[1]).toEqual({ text: MASKED });
  });

  it('a paired device: the send its stream receives', async () => {
    const delivered: DeviceOutbound[] = [];
    bindDeviceSink({
      deliver: async (_to, out) => {
        delivered.push(out);
        return { messageId: 'm' };
      },
    });
    await getAdapter('device').sendText({ entityId: 'ws' }, 'dev-1', REPLY);
    expect(delivered).toEqual([{ kind: 'text', text: MASKED }]);
  });

  it('a card: its text and labels masked, its callback id intact', async () => {
    await getAdapter('telegram').sendApprovalCard!({ botToken: '1:x' }, '42', {
      text: `Run curl -H 'Authorization: ${fakeBearer('Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1')}'?`,
      approveLabel: 'Approve',
      rejectLabel: 'Reject',
      callbackId: 'apr:0b3d',
    });
    const body = telegramBodies()[0]!;
    expect(String(body['text'])).toContain(`Bearer ${REDACTED_TEXT}`);
    expect(JSON.stringify(body['reply_markup'])).toContain('apr:0b3d');
  });

  it('a long reply: masked before the adapter cuts it, so no piece of the key crosses a cut', async () => {
    // The key straddles the first chunk boundary of the Bot API (3 900 characters).
    const long = 'x'.repeat(3880) + ' ' + KEY + ' ' + 'y'.repeat(200);
    await getAdapter('telegram').sendText({ botToken: '1:x' }, '42', long);
    const sent = telegramBodies()
      .map((b) => String(b['text']))
      .join('');
    expect(sent).not.toContain(KEY.slice(0, 12));
    expect(sent).not.toContain(KEY.slice(-12));
    expect(sent).toContain(REDACTED_TEXT);
  });
});

describe('the senders the package publishes post masked text @cap:parler-par-canal-externe/moteur', () => {
  it('a Telegram message and its keyboard labels; the callback data intact', async () => {
    await sendTelegramMessage({
      botToken: '1:x',
      chatId: '42',
      text: REPLY,
      inlineKeyboard: [[{ text: `Use ${KEY}`, callback_data: 'auth:1:a' }]],
    });
    const body = telegramBodies()[0]!;
    expect(body['text']).toBe(MASKED);
    expect(body['reply_markup']).toEqual({
      inline_keyboard: [[{ text: `Use ${REDACTED_TEXT}`, callback_data: 'auth:1:a' }]],
    });
  });

  it('an edited message, a callback toast and a caption', async () => {
    await editTelegramMessageText({ botToken: '1:x', chatId: '42', messageId: 1, text: REPLY });
    await answerTelegramCallback('1:x', 'cb-1', REPLY);
    await sendTelegramPhoto({
      botToken: '1:x',
      chatId: '42',
      photo: new Uint8Array([1, 2, 3]),
      caption: REPLY,
    });
    const bodies = telegramBodies();
    expect(bodies[0]?.['text']).toBe(MASKED);
    expect(bodies[1]?.['text']).toBe(MASKED);
    const form = vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.body as FormData;
    expect(form.get('caption')).toBe(MASKED);
  });

  it('a WhatsApp socket: text and caption masked, the rest of the content as it was', async () => {
    const send = vi.fn().mockResolvedValue('id');
    const handle = outboundWhatsAppHandle({
      bindingKey: 'k',
      events: new EventEmitter(),
      getStatus: () => 'open',
      getIdentity: () => null,
      send,
      listGroups: async () => [],
    } as unknown as WhatsAppHandle);
    const bytes = Buffer.from([9, 9]);
    await handle.send('j', { image: bytes, caption: REPLY } as never);
    await handle.send('j', { text: REPLY } as never);
    expect(send.mock.calls[0]?.[1]).toEqual({ image: bytes, caption: MASKED });
    expect(send.mock.calls[1]?.[1]).toEqual({ text: MASKED });
  });
});

describe('outboundAdapter masks every text an adapter posts, whatever the channel @cap:parler-par-canal-externe/moteur', () => {
  /** An adapter that records what it was asked to post. */
  function recording(): { adapter: ChannelAdapter; posted: unknown[] } {
    const posted: unknown[] = [];
    const ok = async (...args: unknown[]) => {
      posted.push(args.slice(2));
      return { messageId: 'm' };
    };
    const adapter: ChannelAdapter = {
      channel: 'slack',
      capabilities: { buttons: true, threads: false, media: true, editMessage: true },
      text: { renders: [], maxMessageChars: 100 },
      sendText: ok,
      sendMedia: ok,
      sendApprovalCard: ok,
      sendQuestionCard: ok,
      sendCard: ok,
      sendChoiceCard: ok,
      editMessageText: async (...args: unknown[]) => {
        posted.push(args.slice(2));
        return { ok: true };
      },
      validateCredentials: async () => ({ id: 'b', username: null, displayName: null }),
    };
    return { adapter, posted };
  }

  it('text, caption, the three cards, the free card and an edit', async () => {
    const { adapter, posted } = recording();
    const a = outboundAdapter(adapter);
    await a.sendText({}, 'c', REPLY, { fromChunk: 2 });
    await a.sendMedia({}, 'c', {
      kind: 'photo',
      bytes: new Uint8Array([1]),
      filename: 'p.png',
      caption: REPLY,
    });
    await a.sendApprovalCard!({}, 'c', {
      text: REPLY,
      approveLabel: REPLY,
      rejectLabel: 'No',
      alwaysLabel: REPLY,
      callbackId: 'apr:1',
    });
    await a.sendQuestionCard!({}, 'c', { text: REPLY, options: [REPLY, 'b'], callbackId: 'apr:2' });
    await a.sendCard!({}, 'c', {
      text: REPLY,
      buttons: [[{ label: REPLY, callbackData: 'el:1' }]],
    });
    await a.sendChoiceCard!({}, 'c', {
      text: REPLY,
      choices: [{ label: REPLY, decision: 'approve', answer: 'yes' }],
      callbackId: 'apr:3',
      images: [{ position: 0, mimeType: 'image/png', caption: REPLY }],
    });
    await a.editMessageText!({}, 'c', 'msg-1', REPLY, [[{ label: REPLY, callbackData: 'el:2' }]]);

    expect(JSON.stringify(posted)).not.toContain(KEY);
    expect(posted).toEqual([
      [MASKED, { fromChunk: 2 }],
      [{ kind: 'photo', bytes: new Uint8Array([1]), filename: 'p.png', caption: MASKED }],
      [
        {
          text: MASKED,
          approveLabel: MASKED,
          rejectLabel: 'No',
          alwaysLabel: MASKED,
          callbackId: 'apr:1',
        },
      ],
      [{ text: MASKED, options: [MASKED, 'b'], callbackId: 'apr:2' }],
      [{ text: MASKED, buttons: [[{ label: MASKED, callbackData: 'el:1' }]] }],
      [
        {
          text: MASKED,
          choices: [{ label: MASKED, decision: 'approve', answer: 'yes' }],
          callbackId: 'apr:3',
          images: [{ position: 0, mimeType: 'image/png', caption: MASKED }],
        },
      ],
      ['msg-1', MASKED, [[{ label: MASKED, callbackData: 'el:2' }]]],
    ]);
  });

  it('keeps what the adapter declares, and what it does not implement stays absent', () => {
    const { adapter } = recording();
    const bare: ChannelAdapter = {
      channel: adapter.channel,
      capabilities: adapter.capabilities,
      text: adapter.text,
      sendText: adapter.sendText,
      sendMedia: adapter.sendMedia,
      validateCredentials: adapter.validateCredentials,
    };
    const a = outboundAdapter(bare);
    expect(a.capabilities).toBe(adapter.capabilities);
    expect(a.text).toBe(adapter.text);
    expect(a.sendApprovalCard).toBeUndefined();
    expect(a.editMessageText).toBeUndefined();
  });
});
