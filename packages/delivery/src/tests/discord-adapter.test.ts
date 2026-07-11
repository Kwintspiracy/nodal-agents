// discord-adapter.test.ts — Discord ChannelAdapter: wire shape sent to discord.js's
// REST client, chunking, approval-card components, error mapping.
//
// discord.js's REST class does its own HTTP/undici plumbing (bucket bookkeeping,
// 429 retry) — mocking at the `fetch` level like the Telegram tests would mean
// re-implementing that plumbing in every test. Instead we spy on REST.prototype's
// get/post/patch directly (the adapter builds a fresh `new REST()` per call, so
// spying on the shared prototype intercepts every instance without any adapter
// changes needed to make it injectable).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REST, Routes, DiscordAPIError, ChannelType } from 'discord.js';
import type { APIMessage, APIUser } from 'discord.js';
import { discordAdapter } from '../channels/discord-adapter.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = 'FAKE.BOT.TOKEN';
const CREDS = { botToken: FAKE_TOKEN };
const CHANNEL_ID = '123456789012345678';

function fakeMessage(id: string): APIMessage {
  return { id } as APIMessage;
}

function unauthorizedError(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 0, message: '401: Unauthorized' },
    0,
    401,
    'GET',
    'https://discord.com/api/v10/users/@me',
    { body: undefined, files: undefined },
  );
}

beforeEach(() => {
  vi.spyOn(REST.prototype, 'get');
  vi.spyOn(REST.prototype, 'post');
  vi.spyOn(REST.prototype, 'patch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discordAdapter.channel / capabilities', () => {
  it('identifies as discord with the expected capability flags', () => {
    expect(discordAdapter.channel).toBe('discord');
    expect(discordAdapter.capabilities).toEqual({
      buttons: true,
      threads: true,
      media: true,
      editMessage: true,
    });
  });
});

describe('discordAdapter.sendText', () => {
  it('posts content + allowed_mentions (users only) to the channel messages route', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce(fakeMessage('42'));

    const result = await discordAdapter.sendText(CREDS, CHANNEL_ID, 'Hello');

    expect(vi.mocked(REST.prototype.post).mock.calls[0]?.[0]).toBe(
      Routes.channelMessages(CHANNEL_ID),
    );
    const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1];
    expect(options?.body).toEqual({
      content: 'Hello',
      allowed_mentions: { parse: ['users'] },
    });
    expect(result).toEqual({ messageId: '42' });
  });

  it('is a no-op passthrough for format "markdown"', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce(fakeMessage('1'));

    await discordAdapter.sendText(CREDS, CHANNEL_ID, '**bold**', { format: 'markdown' });

    const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1];
    expect(options?.body).toEqual({
      content: '**bold**',
      allowed_mentions: { parse: ['users'] },
    });
  });

  it('throws send_failed for format "html" without calling the API', async () => {
    await expect(
      discordAdapter.sendText(CREDS, CHANNEL_ID, '<b>x</b>', { format: 'html' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
    expect(REST.prototype.post).not.toHaveBeenCalled();
  });

  it('splits text over 2000 chars into multiple chunked sends', async () => {
    vi.mocked(REST.prototype.post).mockImplementation(() => Promise.resolve(fakeMessage('9')));

    const longText = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(20)).join('\n');
    expect(longText.length).toBeGreaterThan(2000);

    await discordAdapter.sendText(CREDS, CHANNEL_ID, longText);

    const calls = vi.mocked(REST.prototype.post).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [, options] of calls) {
      const content = (options?.body as { content: string }).content;
      expect(content.length).toBeLessThanOrEqual(2000);
    }
  });

  it('does not split a surrogate pair (emoji) across two hard-split chunks', async () => {
    vi.mocked(REST.prototype.post).mockImplementation(() => Promise.resolve(fakeMessage('1')));

    // Same construction as the Telegram surrogate-pair regression test: a 1-char
    // prefix shifts every 2-code-unit emoji onto an odd/even boundary so the
    // (even) 2000-char cap lands exactly between a high and low surrogate.
    const emoji = '😀'; // U+1F600, 2 code units: high surrogate + low surrogate
    const longLine = 'x' + emoji.repeat(1500); // 3001 code units, over the 2000 cap

    await discordAdapter.sendText(CREDS, CHANNEL_ID, longLine);

    const sentTexts = vi
      .mocked(REST.prototype.post)
      .mock.calls.map(([, options]) => (options?.body as { content: string }).content);
    expect(sentTexts.length).toBeGreaterThan(1);
    for (const chunk of sentTexts) {
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      const firstCode = chunk.charCodeAt(0);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    }
    expect(sentTexts.join('')).toBe(longLine);
  });

  it('throws discord_no_token when botToken credential is missing', async () => {
    await expect(discordAdapter.sendText({}, CHANNEL_ID, 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'discord_no_token',
    );
    expect(REST.prototype.post).not.toHaveBeenCalled();
  });

  it('throws discord_no_channel_id when conversationId is empty', async () => {
    await expect(discordAdapter.sendText(CREDS, '', 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'discord_no_channel_id',
    );
    expect(REST.prototype.post).not.toHaveBeenCalled();
  });

  it('maps a DiscordAPIError to send_failed', async () => {
    vi.mocked(REST.prototype.post).mockRejectedValueOnce(
      new DiscordAPIError(
        { code: 50001, message: 'Missing Access' },
        50001,
        403,
        'POST',
        'https://discord.com/api/v10/channels/x/messages',
        { body: undefined, files: undefined },
      ),
    );

    await expect(discordAdapter.sendText(CREDS, CHANNEL_ID, 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
  });
});

describe('discordAdapter.sendMedia', () => {
  const BYTES = new Uint8Array([1, 2, 3, 4]);

  it.each(['photo', 'document', 'video', 'audio', 'voice'] as const)(
    'uploads "%s" as a single files[0] attachment with caption as content',
    async (kind) => {
      vi.mocked(REST.prototype.post).mockResolvedValueOnce(fakeMessage('7'));

      const result = await discordAdapter.sendMedia(CREDS, CHANNEL_ID, {
        kind,
        bytes: BYTES,
        filename: 'a.bin',
        caption: 'a caption',
      });

      expect(vi.mocked(REST.prototype.post).mock.calls[0]?.[0]).toBe(
        Routes.channelMessages(CHANNEL_ID),
      );
      const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1];
      expect(options?.body).toEqual({
        content: 'a caption',
        allowed_mentions: { parse: ['users'] },
      });
      expect(options?.files).toEqual([{ name: 'a.bin', data: Buffer.from(BYTES) }]);
      expect(result).toEqual({ messageId: '7' });
    },
  );

  it('omits content when no caption is given', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce(fakeMessage('8'));

    await discordAdapter.sendMedia(CREDS, CHANNEL_ID, {
      kind: 'document',
      bytes: BYTES,
      filename: 'f.bin',
    });

    const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1];
    expect(options?.body).toEqual({ allowed_mentions: { parse: ['users'] } });
  });
});

describe('discordAdapter.sendApprovalCard', () => {
  it('produces the EXACT components wire shape the neutral approval-callback parser expects', async () => {
    vi.mocked(REST.prototype.post).mockResolvedValueOnce(fakeMessage('5'));

    const result = await discordAdapter.sendApprovalCard!(CREDS, CHANNEL_ID, {
      text: 'Approve this?',
      approveLabel: '✅ Approve',
      rejectLabel: '❌ Reject',
      callbackId: 'apr:req-123',
    });

    const options = vi.mocked(REST.prototype.post).mock.calls[0]?.[1];
    const body = options?.body as {
      content: string;
      components: unknown;
      allowed_mentions: unknown;
    };
    expect(body.content).toBe('Approve this?');
    expect(body.allowed_mentions).toEqual({ parse: ['users'] });
    expect(body.components).toEqual([
      {
        type: 1, // ActionRow
        components: [
          { type: 2, style: 3, label: '✅ Approve', custom_id: 'apr:req-123:a' }, // Button, Success
          { type: 2, style: 4, label: '❌ Reject', custom_id: 'apr:req-123:r' }, // Button, Danger
        ],
      },
    ]);
    expect(result).toEqual({ messageId: '5' });
  });
});

describe('discordAdapter.editMessageText', () => {
  it('PATCHes the channel message route with new content + allowed_mentions', async () => {
    vi.mocked(REST.prototype.patch).mockResolvedValueOnce(fakeMessage('42'));

    await discordAdapter.editMessageText!(CREDS, CHANNEL_ID, '42', 'Resolved ✅');

    expect(vi.mocked(REST.prototype.patch).mock.calls[0]?.[0]).toBe(
      Routes.channelMessage(CHANNEL_ID, '42'),
    );
    const options = vi.mocked(REST.prototype.patch).mock.calls[0]?.[1];
    expect(options?.body).toEqual({
      content: 'Resolved ✅',
      allowed_mentions: { parse: ['users'] },
    });
  });

  it('never throws — a failed edit must not undo a decision that already happened', async () => {
    vi.mocked(REST.prototype.patch).mockRejectedValueOnce(new Error('boom'));

    await expect(
      discordAdapter.editMessageText!(CREDS, CHANNEL_ID, '42', 'Resolved ✅'),
    ).resolves.toBeUndefined();
  });
});

describe('discordAdapter.listConversations', () => {
  it('maps guilds + their text-capable channels into DiscoveredConversation[]', async () => {
    vi.mocked(REST.prototype.get).mockImplementation((route) => {
      if (route === Routes.userGuilds()) {
        return Promise.resolve([
          { id: 'g1', name: 'Guild One' },
          { id: 'g2', name: 'Guild Two' },
        ]);
      }
      if (route === Routes.guildChannels('g1')) {
        return Promise.resolve([{ id: 'c1', name: 'general', type: ChannelType.GuildText }]);
      }
      if (route === Routes.guildChannels('g2')) {
        return Promise.resolve([
          { id: 'c2', name: 'announcements', type: ChannelType.GuildAnnouncement },
        ]);
      }
      throw new Error(`unexpected route ${String(route)}`);
    });

    const result = await discordAdapter.listConversations!(CREDS);

    expect(result).toEqual([
      { conversationId: 'c1', name: '#general', kind: 'channel', groupName: 'Guild One' },
      { conversationId: 'c2', name: '#announcements', kind: 'channel', groupName: 'Guild Two' },
    ]);
  });

  it('excludes non-text-capable channel types (voice, category)', async () => {
    vi.mocked(REST.prototype.get).mockImplementation((route) => {
      if (route === Routes.userGuilds()) {
        return Promise.resolve([{ id: 'g1', name: 'Guild One' }]);
      }
      return Promise.resolve([
        { id: 'c1', name: 'general', type: ChannelType.GuildText },
        { id: 'c2', name: 'Voice Chat', type: ChannelType.GuildVoice },
        { id: 'c3', name: 'Category', type: ChannelType.GuildCategory },
        { id: 'c4', name: 'announcements', type: ChannelType.GuildAnnouncement },
      ]);
    });

    const result = await discordAdapter.listConversations!(CREDS);

    expect(result.map((c) => c.conversationId)).toEqual(['c1', 'c4']);
  });

  it('truncates to the MAX_GUILDS bound when the bot is in more guilds than that', async () => {
    const guilds = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}` }));
    vi.mocked(REST.prototype.get).mockImplementation((route) => {
      if (route === Routes.userGuilds()) return Promise.resolve(guilds);
      return Promise.resolve([{ id: 'c0', name: 'general', type: ChannelType.GuildText }]);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await discordAdapter.listConversations!(CREDS);

    // 25 guilds walked (the bound), each contributing exactly one channel here
    expect(result).toHaveLength(25);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws discord_no_token when botToken credential is missing', async () => {
    await expect(discordAdapter.listConversations!({})).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'discord_no_token',
    );
    expect(REST.prototype.get).not.toHaveBeenCalled();
  });
});

describe('discordAdapter.validateCredentials', () => {
  it('maps GET /users/@me onto BotIdentity, preferring global_name for displayName', async () => {
    const user: APIUser = {
      id: '555',
      username: 'my_bot',
      discriminator: '0',
      global_name: 'My Bot',
      avatar: null,
    } as APIUser;
    vi.mocked(REST.prototype.get).mockResolvedValueOnce(user);

    const identity = await discordAdapter.validateCredentials(CREDS);

    expect(vi.mocked(REST.prototype.get).mock.calls[0]?.[0]).toBe(Routes.user());
    expect(identity).toEqual({ id: '555', username: 'my_bot', displayName: 'My Bot' });
  });

  it('falls back to username when global_name is null', async () => {
    const user: APIUser = {
      id: '555',
      username: 'my_bot',
      discriminator: '0',
      global_name: null,
      avatar: null,
    } as APIUser;
    vi.mocked(REST.prototype.get).mockResolvedValueOnce(user);

    const identity = await discordAdapter.validateCredentials(CREDS);

    expect(identity.displayName).toBe('my_bot');
  });

  it('throws discord_no_token when botToken credential is missing', async () => {
    await expect(discordAdapter.validateCredentials({})).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'discord_no_token',
    );
    expect(REST.prototype.get).not.toHaveBeenCalled();
  });

  it('throws discord_invalid_token on a 401 DiscordAPIError', async () => {
    vi.mocked(REST.prototype.get).mockRejectedValueOnce(unauthorizedError());

    await expect(discordAdapter.validateCredentials(CREDS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'discord_invalid_token',
    );
  });

  it('maps a non-401 failure to send_failed, not discord_invalid_token', async () => {
    vi.mocked(REST.prototype.get).mockRejectedValueOnce(
      new DiscordAPIError(
        { code: 0, message: 'Internal Server Error' },
        0,
        500,
        'GET',
        'https://discord.com/api/v10/users/@me',
        { body: undefined, files: undefined },
      ),
    );

    await expect(discordAdapter.validateCredentials(CREDS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'send_failed',
    );
  });
});
