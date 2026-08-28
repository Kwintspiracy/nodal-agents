// telegram-send-message.test.ts — createTelegramSendMessageTool
// Tests:
//   - happy path: chatId from ctx.jobChatId, sends correct args to the adapter's sendText
//   - happy path: explicit chatId arg overrides ctx.jobChatId (allowed)
//   - missing chatId + no jobChatId → throws telegram_no_recipient
//   - missing bot token in DB → throws telegram_no_bot_token
//   - adapter.sendText throws DeliveryError → propagates to caller (fail loud)
//   - F1: explicit chatId not on the allow-list → throws telegram_chat_not_allowed
//   - F1: explicit chatId === ctx.jobChatId → sends WITHOUT an allow-list lookup
//   - F1: entity-approved explicit chatId → sends with the agent's OWN token
//
// S3: the tool now dispatches through getAdapter(...).sendText — mocked here as
// the tool-layer boundary. The adapter's own Telegram wire-format translation
// is covered by packages/delivery/src/tests/telegram-adapter.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import { createTelegramSendMessageTool } from '../telegram-send-message';
import type { ToolContext } from '../../types';
import { DeliveryError } from '@nodal-agents/delivery';

// ─── Mock @nodal-agents/delivery ───────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest; the factory must not
// reference variables declared later. Use vi.hoisted to create the mock fn
// in the hoisted scope so both the factory and the test body can access it.

const { sendTextMock, getAdapterMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(),
  getAdapterMock: vi.fn(() => ({ sendText: sendTextMock })),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: getAdapterMock,
  };
});

// ─── Mock @nodal-agents/db ─────────────────────────────────────────────────────────

const {
  isChatAllowedMock,
  resolveOwnerChatIdMock,
  getChannelBindingMock,
  getBindingCredentialsMock,
} = vi.hoisted(() => ({
  isChatAllowedMock: vi.fn(),
  resolveOwnerChatIdMock: vi.fn(),
  getChannelBindingMock: vi.fn(),
  getBindingCredentialsMock: vi.fn(),
}));

// We build a minimal fake DB that returns agent rows on demand
function makeDb(telegramBotToken: string | null | undefined) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(telegramBotToken !== undefined ? [{ telegramBotToken }] : []),
        }),
      }),
    }),
  };
}

// We also need the agents table import (a Drizzle table object) — mock it
vi.mock('@nodal-agents/db', () => {
  const agents = {
    telegramBotToken: 'telegram_bot_token',
    id: 'id',
  };
  const eq = (col: unknown, val: unknown) => ({ col, val });
  return {
    agents,
    eq,
    isConversationAllowed: isChatAllowedMock,
    resolveOwnerConversation: resolveOwnerChatIdMock,
    getChannelBinding: getChannelBindingMock,
    getBindingCredentials: getBindingCredentialsMock,
  };
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(
  overrides: {
    jobChatId?: string | null;
    db?: unknown;
    entityId?: string;
    agentId?: string;
  } = {},
): ToolContext {
  return {
    jobId: 'job-123',
    agentId: overrides.agentId ?? 'agent-abc',
    entityId: overrides.entityId ?? 'entity-xyz',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TEST_TOKEN')) as unknown as ToolContext['db'],
  };
}

// resolveBotToken routes the TELEGRAM path through getBindingCredentials now
// (it owns the per-channel split AND the at-rest decryption) where it used to
// read agents.telegram_bot_token inline. This stand-in reproduces that branch
// against the fake db. Reinstalled after every mockReset so a cross-channel
// test's mockResolvedValueOnce still takes precedence.
function installTelegramBindingCredentialsDefault(): void {
  getBindingCredentialsMock.mockImplementation(
    async (db: {
      select: () => { from: () => { where: () => { limit: () => Promise<unknown[]> } } };
    }) => {
      const rows = await db.select().from().where().limit();
      const row = rows[0] as { telegramBotToken?: string | null } | undefined;
      return row?.telegramBotToken ? { botToken: row.telegramBotToken } : null;
    },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTelegramSendMessageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMock.mockResolvedValue({ messageId: '42' });
    isChatAllowedMock.mockResolvedValue(true);
    resolveOwnerChatIdMock.mockResolvedValue(null);
    installTelegramBindingCredentialsDefault();
  });

  it('sends message using ctx.jobChatId when no chatId arg provided', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    const result = await tool.execute({ text: 'Hello from cron!' }, ctx);

    expect(sendTextMock).toHaveBeenCalledOnce();
    expect(sendTextMock).toHaveBeenCalledWith(
      { botToken: 'bot:TEST_TOKEN' },
      '99887766',
      'Hello from cron!',
    );
    expect(result.messageId).toBe('42');
    // omitted chatId falls back to jobChatId without an allow-list lookup
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('sends message using explicit chatId arg when provided (overrides ctx.jobChatId, allowed)', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: '99887766', entityId: 'entity-xyz', agentId: 'agent-abc' });

    await tool.execute({ chatId: '11223344', text: 'Direct message' }, ctx);

    expect(sendTextMock).toHaveBeenCalledWith(
      { botToken: 'bot:TEST_TOKEN' },
      '11223344',
      'Direct message',
    );
    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-xyz',
      agentId: 'agent-abc',
      channel: 'telegram',
      conversationId: '11223344',
    });
  });

  it('throws telegram_no_recipient when no chatId provided and ctx.jobChatId is null', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: null });

    await expect(tool.execute({ text: 'Who receives this?' }, ctx)).rejects.toMatchObject({
      message: 'telegram_no_recipient',
    });

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('throws telegram_no_bot_token when agent has no telegramBotToken in DB', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({
      jobChatId: '12345',
      db: makeDb(null),
    });

    await expect(tool.execute({ text: 'Hi' }, ctx)).rejects.toMatchObject({
      message: 'telegram_no_bot_token',
    });

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('propagates DeliveryError from the adapter (fail loud)', async () => {
    sendTextMock.mockRejectedValueOnce(new DeliveryError('telegram_rate_limited', 'Rate limited'));

    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    await expect(tool.execute({ text: 'rate limited?' }, ctx)).rejects.toBeInstanceOf(
      DeliveryError,
    );
    sendTextMock.mockRejectedValueOnce(new DeliveryError('telegram_rate_limited', 'Rate limited'));
    await expect(tool.execute({ text: 'rate limited?' }, ctx)).rejects.toMatchObject({
      code: 'telegram_rate_limited',
    });
  });

  it('F1: throws telegram_chat_not_allowed for an explicit chatId not on the allow-list', async () => {
    isChatAllowedMock.mockResolvedValueOnce(false);
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await expect(tool.execute({ chatId: '00000000', text: 'sneaky' }, ctx)).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('F1: skips the allow-list lookup when the explicit chatId equals ctx.jobChatId', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await tool.execute({ chatId: '99887766', text: 'same chat' }, ctx);

    expect(isChatAllowedMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledWith(expect.anything(), '99887766', 'same chat');
  });

  it("F1: entity-approved explicit chatId sends with the agent's OWN token (no inheritance)", async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({
      jobChatId: null,
      entityId: 'entity-root',
      agentId: 'agent-child',
    });

    await tool.execute({ chatId: '77778888', text: 'entity-approved reply' }, ctx);

    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-root',
      agentId: 'agent-child',
      channel: 'telegram',
      conversationId: '77778888',
    });
    expect(sendTextMock).toHaveBeenCalledWith(
      { botToken: 'bot:TEST_TOKEN' },
      '77778888',
      'entity-approved reply',
    );
  });

  it('has correct static metadata', () => {
    const tool = createTelegramSendMessageTool();

    expect(tool.name).toBe('telegram_send_message');
    expect(tool.riskLevel).toBe('write');
    expect(tool.description).toContain('Telegram');
    expect(tool.description).toContain('chatId');

    // Input schema validates correctly
    const validParse = tool.inputSchema.safeParse({ text: 'hello' });
    expect(validParse.success).toBe(true);

    const emptyTextParse = tool.inputSchema.safeParse({ text: '' });
    expect(emptyTextParse.success).toBe(false);
  });

  it('input schema accepts chatId as optional string', () => {
    const tool = createTelegramSendMessageTool();
    const schema = tool.inputSchema as z.ZodObject<{
      chatId: z.ZodOptional<z.ZodString>;
      text: z.ZodString;
    }>;

    expect(schema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(schema.safeParse({ chatId: '123', text: 'hi' }).success).toBe(true);
    expect(schema.safeParse({ chatId: 123, text: 'hi' }).success).toBe(false);
  });

  // ─── Optional `channel` — cross-channel send ──────────────────────────────

  describe('optional channel — cross-channel send', () => {
    beforeEach(() => {
      getChannelBindingMock.mockReset();
      getBindingCredentialsMock.mockReset();
      installTelegramBindingCredentialsDefault();
      getAdapterMock.mockClear();
    });

    it("omitted channel stays byte-identical: no binding check, sends via the job's own (telegram) adapter", async () => {
      const tool = createTelegramSendMessageTool();
      const ctx = makeCtx({ jobChatId: '99887766' });

      await tool.execute({ text: 'plain' }, ctx);

      expect(getChannelBindingMock).not.toHaveBeenCalled();
      expect(getAdapterMock).toHaveBeenCalledWith('telegram');
      expect(sendTextMock).toHaveBeenCalledWith(
        { botToken: 'bot:TEST_TOKEN' },
        '99887766',
        'plain',
      );
    });

    it('sends via the TARGET channel adapter when an explicit channel differs from the job channel', async () => {
      // resolveChannelForJob's binding check runs once each from
      // resolveRecipientChatId, resolveBotToken, and the adapter lookup below —
      // all three must see the same enabled binding.
      getChannelBindingMock.mockResolvedValue({ enabled: true });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      isChatAllowedMock.mockResolvedValueOnce(true);

      const tool = createTelegramSendMessageTool();
      const ctx = makeCtx({ jobChatId: '99887766' });

      await tool.execute({ chatId: '55556666', text: 'cross-channel', channel: 'discord' }, ctx);

      expect(getChannelBindingMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
      expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
        entityId: ctx.entityId,
        agentId: ctx.agentId,
        channel: 'discord',
        conversationId: '55556666',
      });
      expect(getAdapterMock).toHaveBeenCalledWith('discord');
      expect(sendTextMock).toHaveBeenCalledWith(
        { botToken: 'discord-token' },
        '55556666',
        'cross-channel',
      );
    });

    it('throws channel_not_connected when there is no enabled binding for the explicit channel — nothing sent', async () => {
      getChannelBindingMock.mockResolvedValueOnce(null);

      const tool = createTelegramSendMessageTool();
      const ctx = makeCtx({ jobChatId: '99887766' });

      await expect(
        tool.execute({ chatId: '55556666', text: 'nope', channel: 'discord' }, ctx),
      ).rejects.toMatchObject({ name: 'channel_not_connected' });

      expect(getBindingCredentialsMock).not.toHaveBeenCalled();
      expect(sendTextMock).not.toHaveBeenCalled();
    });

    it('throws telegram_chat_not_allowed for a cross-channel target even when the chat id equals ctx.jobChatId (exemption bypass)', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      isChatAllowedMock.mockResolvedValueOnce(false);

      const tool = createTelegramSendMessageTool();
      const ctx = makeCtx({ jobChatId: '99887766' });

      await expect(
        tool.execute({ chatId: '99887766', text: 'sneaky', channel: 'discord' }, ctx),
      ).rejects.toMatchObject({ name: 'telegram_chat_not_allowed' });

      expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
        entityId: ctx.entityId,
        agentId: ctx.agentId,
        channel: 'discord',
        conversationId: '99887766',
      });
      expect(sendTextMock).not.toHaveBeenCalled();
    });
  });
});
