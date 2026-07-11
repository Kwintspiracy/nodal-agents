// slack-adapter.test.ts — Slack ChannelAdapter: wire shape sent to
// @slack/web-api's WebClient, chunking, mrkdwn conversion, approval-card
// blocks, error mapping.
//
// WebClient dispatches almost every method through its own `apiCall(method,
// options)` (bound once per instance via bindApiCall at construction time) —
// spying on `WebClient.prototype.apiCall` intercepts chat.postMessage,
// chat.update and auth.test uniformly, the same way the Discord tests spy on
// REST.prototype's get/post/patch. `files.uploadV2` is the one method bound
// straight to its own instance method (bindFilesUploadV2) instead of routing
// through apiCall — it internally does a 3-step flow (get an upload URL,
// PUT the bytes to it over raw HTTP, then complete the upload), so it gets
// its own `WebClient.prototype.filesUploadV2` spy to short-circuit that flow
// entirely rather than partially mocking three different transports.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebClient, ErrorCode } from '@slack/web-api';
import type {
  WebAPIPlatformError,
  ChatPostMessageResponse,
  AuthTestResponse,
} from '@slack/web-api';
import { slackAdapter } from '../channels/slack-adapter.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_BOT_TOKEN = 'xoxb-fake-bot-token';
const FAKE_APP_TOKEN = 'xapp-fake-app-token';
const CREDS = { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN };
const CHANNEL_ID = 'C0123456789';

function fakePostMessageResult(ts: string): ChatPostMessageResponse {
  return { ok: true, channel: CHANNEL_ID, ts } as ChatPostMessageResponse;
}

function slackPlatformError(errorCode: string): WebAPIPlatformError {
  const err = new Error(`An API error occurred: ${errorCode}`);
  return Object.assign(err, {
    code: ErrorCode.PlatformError,
    data: { ok: false, error: errorCode },
  }) as WebAPIPlatformError;
}

beforeEach(() => {
  vi.spyOn(WebClient.prototype, 'apiCall');
  vi.spyOn(WebClient.prototype, 'filesUploadV2');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('slackAdapter.channel / capabilities', () => {
  it('identifies as slack with the expected capability flags', () => {
    expect(slackAdapter.channel).toBe('slack');
    expect(slackAdapter.capabilities).toEqual({
      buttons: true,
      threads: true,
      media: true,
      editMessage: true,
    });
  });
});

describe('slackAdapter.sendText', () => {
  it('posts channel + text to chat.postMessage', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(fakePostMessageResult('1.1'));

    const result = await slackAdapter.sendText(CREDS, CHANNEL_ID, 'Hello');

    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.postMessage');
    expect(options).toEqual({ channel: CHANNEL_ID, text: 'Hello' });
    expect(result).toEqual({ messageId: '1.1' });
  });

  it.each([
    ['**bold**', '*bold*'],
    ['prefix **bold** suffix', 'prefix *bold* suffix'],
    ['_italics_ untouched', '_italics_ untouched'],
    ['[click me](https://example.com)', '<https://example.com|click me>'],
    ['see **this** and [a link](https://x.io)', 'see *this* and <https://x.io|a link>'],
  ])('converts markdown "%s" to mrkdwn "%s"', async (input, expected) => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(fakePostMessageResult('1.2'));

    await slackAdapter.sendText(CREDS, CHANNEL_ID, input, { format: 'markdown' });

    const [, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect((options as { text: string }).text).toBe(expected);
  });

  it('is a no-op passthrough for format "plain"', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(fakePostMessageResult('1.3'));

    await slackAdapter.sendText(CREDS, CHANNEL_ID, '**not bold**', { format: 'plain' });

    const [, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect((options as { text: string }).text).toBe('**not bold**');
  });

  it('throws send_failed for format "html" without calling the API', async () => {
    await expect(
      slackAdapter.sendText(CREDS, CHANNEL_ID, '<b>x</b>', { format: 'html' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('splits text over 3900 chars into multiple chunked sends', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockImplementation(() =>
      Promise.resolve(fakePostMessageResult('9.9')),
    );

    const longText = Array.from({ length: 100 }, (_, i) => `line ${i} `.repeat(20)).join('\n');
    expect(longText.length).toBeGreaterThan(3900);

    await slackAdapter.sendText(CREDS, CHANNEL_ID, longText);

    const calls = vi.mocked(WebClient.prototype.apiCall).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [, options] of calls) {
      const text = (options as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(3900);
    }
  });

  it('does not split a surrogate pair (emoji) across two hard-split chunks', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockImplementation(() =>
      Promise.resolve(fakePostMessageResult('1.4')),
    );

    // Same construction as the Discord/Telegram surrogate-pair regression
    // test: a 1-char prefix shifts every 2-code-unit emoji onto an odd/even
    // boundary so the (even) 3900-char cap lands exactly between a high and
    // low surrogate.
    const emoji = '😀'; // U+1F600, 2 code units: high surrogate + low surrogate
    const longLine = 'x' + emoji.repeat(3000); // 6001 code units, over the 3900 cap

    await slackAdapter.sendText(CREDS, CHANNEL_ID, longLine);

    const sentTexts = vi
      .mocked(WebClient.prototype.apiCall)
      .mock.calls.map(([, options]) => (options as { text: string }).text);
    expect(sentTexts.length).toBeGreaterThan(1);
    for (const chunk of sentTexts) {
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      const firstCode = chunk.charCodeAt(0);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    }
    expect(sentTexts.join('')).toBe(longLine);
  });

  it('throws slack_no_token when botToken credential is missing', async () => {
    await expect(
      slackAdapter.sendText({ appToken: FAKE_APP_TOKEN }, CHANNEL_ID, 'Hello'),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_no_token',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('throws slack_no_channel_id when conversationId is empty', async () => {
    await expect(slackAdapter.sendText(CREDS, '', 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_no_channel_id',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('maps a platform error to send_failed', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockRejectedValueOnce(
      slackPlatformError('channel_not_found'),
    );

    await expect(slackAdapter.sendText(CREDS, CHANNEL_ID, 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
  });
});

describe('slackAdapter.sendMedia', () => {
  const BYTES = new Uint8Array([1, 2, 3, 4]);

  it.each(['photo', 'document', 'video', 'audio', 'voice'] as const)(
    'uploads "%s" via files.uploadV2 with caption as initial_comment',
    async (kind) => {
      vi.mocked(WebClient.prototype.filesUploadV2).mockResolvedValueOnce({
        files: [{ files: [{ id: 'F123' }] }],
      } as never);

      const result = await slackAdapter.sendMedia(CREDS, CHANNEL_ID, {
        kind,
        bytes: BYTES,
        filename: 'a.bin',
        caption: 'a caption',
      });

      const args = vi.mocked(WebClient.prototype.filesUploadV2).mock.calls[0]?.[0] as {
        channel_id: string;
        filename: string;
        file: Buffer;
        initial_comment?: string;
      };
      expect(args.channel_id).toBe(CHANNEL_ID);
      expect(args.filename).toBe('a.bin');
      expect(args.file).toEqual(Buffer.from(BYTES));
      expect(args.initial_comment).toBe('a caption');
      expect(result).toEqual({ messageId: 'F123' });
    },
  );

  it('omits initial_comment when no caption is given', async () => {
    vi.mocked(WebClient.prototype.filesUploadV2).mockResolvedValueOnce({
      files: [{ files: [{ id: 'F456' }] }],
    } as never);

    await slackAdapter.sendMedia(CREDS, CHANNEL_ID, {
      kind: 'document',
      bytes: BYTES,
      filename: 'f.bin',
    });

    const args = vi.mocked(WebClient.prototype.filesUploadV2).mock.calls[0]?.[0] as {
      initial_comment?: string;
    };
    expect(args.initial_comment).toBeUndefined();
  });

  it('throws send_failed when files.uploadV2 returns no file id', async () => {
    vi.mocked(WebClient.prototype.filesUploadV2).mockResolvedValueOnce({ files: [] } as never);

    await expect(
      slackAdapter.sendMedia(CREDS, CHANNEL_ID, {
        kind: 'document',
        bytes: BYTES,
        filename: 'f.bin',
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
  });
});

describe('slackAdapter.sendApprovalCard', () => {
  it('produces the EXACT blocks wire shape the neutral approval-callback parser expects', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(fakePostMessageResult('2.1'));

    const result = await slackAdapter.sendApprovalCard!(CREDS, CHANNEL_ID, {
      text: 'Approve this?',
      approveLabel: '✅ Approve',
      rejectLabel: '❌ Reject',
      callbackId: 'apr:req-123',
    });

    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.postMessage');
    const body = options as { channel: string; text: string; blocks: unknown };
    expect(body.channel).toBe(CHANNEL_ID);
    expect(body.text).toBe('Approve this?');
    expect(body.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Approve this?' } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '✅ Approve' },
            action_id: 'apr:req-123:a',
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '❌ Reject' },
            action_id: 'apr:req-123:r',
          },
        ],
      },
    ]);
    expect(result).toEqual({ messageId: '2.1' });
  });
});

describe('slackAdapter.editMessageText', () => {
  it('calls chat.update with channel + ts + new text', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(fakePostMessageResult('42.1'));

    await slackAdapter.editMessageText!(CREDS, CHANNEL_ID, '42.1', 'Resolved ✅');

    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('chat.update');
    expect(options).toEqual({ channel: CHANNEL_ID, ts: '42.1', text: 'Resolved ✅' });
  });

  it('never throws — a failed edit must not undo a decision that already happened', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockRejectedValueOnce(new Error('boom'));

    await expect(
      slackAdapter.editMessageText!(CREDS, CHANNEL_ID, '42.1', 'Resolved ✅'),
    ).resolves.toBeUndefined();
  });
});

describe('slackAdapter.listConversations', () => {
  it('maps public/private channels, im, and mpim into DiscoveredConversation[]', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      channels: [
        { id: 'C1', name: 'general', is_channel: true },
        { id: 'G1', name: 'secret-team', is_group: true, is_private: true },
        { id: 'D1', is_im: true, user: 'U123' },
        { id: 'M1', name: 'mpdm-a--b-1', is_mpim: true },
      ],
    } as never);

    const result = await slackAdapter.listConversations!(CREDS);

    expect(result).toEqual([
      { conversationId: 'C1', name: '#general', kind: 'channel' },
      { conversationId: 'G1', name: '#secret-team', kind: 'channel' },
      { conversationId: 'D1', name: 'U123', kind: 'private' },
      { conversationId: 'M1', name: 'mpdm-a--b-1', kind: 'group' },
    ]);
  });

  it('calls users.conversations with exclude_archived + the expected types', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      channels: [],
    } as never);

    await slackAdapter.listConversations!(CREDS);

    const [method, options] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('users.conversations');
    expect(options).toEqual({
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
    });
  });

  it('skips an im entry with no user id (no display resolution to fall back on)', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce({
      ok: true,
      channels: [{ id: 'D2', is_im: true }],
    } as never);

    const result = await slackAdapter.listConversations!(CREDS);

    expect(result).toEqual([]);
  });

  it('throws slack_no_token when botToken credential is missing', async () => {
    await expect(slackAdapter.listConversations!({ appToken: FAKE_APP_TOKEN })).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_no_token',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });
});

describe('slackAdapter.validateCredentials', () => {
  function fakeAuthTest(overrides: Partial<AuthTestResponse>): AuthTestResponse {
    return { ok: true, ...overrides } as AuthTestResponse;
  }

  it('maps auth.test onto BotIdentity, preferring bot_id for id', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(
      fakeAuthTest({ bot_id: 'B123', user_id: 'U999', user: 'my_bot' }),
    );

    const identity = await slackAdapter.validateCredentials(CREDS);

    const [method] = vi.mocked(WebClient.prototype.apiCall).mock.calls[0]!;
    expect(method).toBe('auth.test');
    expect(identity).toEqual({ id: 'B123', username: 'my_bot', displayName: 'my_bot' });
  });

  it('falls back to user_id when bot_id is absent', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockResolvedValueOnce(
      fakeAuthTest({ user_id: 'U999', user: 'my_bot' }),
    );

    const identity = await slackAdapter.validateCredentials(CREDS);

    expect(identity.id).toBe('U999');
  });

  it('throws slack_no_token when botToken credential is missing', async () => {
    await expect(slackAdapter.validateCredentials({ appToken: FAKE_APP_TOKEN })).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_no_token',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('throws slack_invalid_token when appToken is missing', async () => {
    await expect(slackAdapter.validateCredentials({ botToken: FAKE_BOT_TOKEN })).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_invalid_token',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('throws slack_invalid_token when appToken is malformed (not "xapp-"-prefixed)', async () => {
    await expect(
      slackAdapter.validateCredentials({ botToken: FAKE_BOT_TOKEN, appToken: 'not-an-app-token' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_invalid_token',
    );
    expect(WebClient.prototype.apiCall).not.toHaveBeenCalled();
  });

  it('throws slack_invalid_token when auth.test rejects with a platform error', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockRejectedValueOnce(
      slackPlatformError('invalid_auth'),
    );

    await expect(slackAdapter.validateCredentials(CREDS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'slack_invalid_token',
    );
  });
});
