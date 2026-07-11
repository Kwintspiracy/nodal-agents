// telegram-send-message.test.ts — createTelegramSendMessageTool
// Tests:
//   - happy path: chatId from ctx.jobChatId, sends correct args to the adapter's sendText
//   - happy path: explicit chatId arg overrides ctx.jobChatId (allowed)
//   - missing chatId + no jobChatId → throws telegram_no_recipient
//   - missing bot token in DB → throws telegram_no_bot_token
//   - adapter.sendText throws DeliveryError → propagates to caller (fail loud)
//   - F1: explicit chatId not on the allow-list → throws telegram_chat_not_allowed
//   - F1: explicit chatId === ctx.jobChatId → sends WITHOUT an allow-list lookup
//   - F1: delegated worker (resolvedTelegramBotToken + entity-approved chatId) → sends
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

const { sendTextMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: () => ({ sendText: sendTextMock }),
  };
});

// ─── Mock @nodal-agents/db ─────────────────────────────────────────────────────────

const { isChatAllowedMock, resolveOwnerChatIdMock } = vi.hoisted(() => ({
  isChatAllowedMock: vi.fn(),
  resolveOwnerChatIdMock: vi.fn(),
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
  };
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(
  overrides: {
    jobChatId?: string | null;
    db?: unknown;
    entityId?: string;
    agentId?: string;
    resolvedTelegramBotToken?: string;
  } = {},
): ToolContext {
  return {
    jobId: 'job-123',
    agentId: overrides.agentId ?? 'agent-abc',
    entityId: overrides.entityId ?? 'entity-xyz',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TEST_TOKEN')) as unknown as ToolContext['db'],
    resolvedTelegramBotToken: overrides.resolvedTelegramBotToken,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTelegramSendMessageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMock.mockResolvedValue({ messageId: '42' });
    isChatAllowedMock.mockResolvedValue(true);
    resolveOwnerChatIdMock.mockResolvedValue(null);
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

  it('F1: delegated worker — resolvedTelegramBotToken + an entity-approved chatId sends with the resolved token', async () => {
    const tool = createTelegramSendMessageTool();
    const ctx = makeCtx({
      jobChatId: null,
      entityId: 'entity-root',
      agentId: 'agent-child',
      resolvedTelegramBotToken: 'root-agent-token',
    });

    await tool.execute({ chatId: '77778888', text: 'delegated reply' }, ctx);

    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-root',
      agentId: 'agent-child',
      channel: 'telegram',
      conversationId: '77778888',
    });
    expect(sendTextMock).toHaveBeenCalledWith(
      { botToken: 'root-agent-token' },
      '77778888',
      'delegated reply',
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
});
