// send-image.test.ts — createSendImageTool
// Tests:
//   (a) resolves chatId from ctx.jobChatId when no chatId arg
//   (b) returns tiny { ok: true, bytes } shape with NO image data
//   (c) throws no_recipient when no chatId anywhere
//   (d) throws no_bot_token when agent has no token in DB
//   (e) throws image_too_large when bytes exceed 10 MB
//   (f) fetch_failed on non-2xx URL response

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendImageTool } from '../send-image';
import type { ToolContext } from '../../types';

// ─── Mock @nodal-agents/delivery ─────────────────────────────────────────────

const { sendTelegramPhotoMock } = vi.hoisted(() => ({
  sendTelegramPhotoMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    sendTelegramPhoto: sendTelegramPhotoMock,
  };
});

// ─── Mock node:fs/promises ────────────────────────────────────────────────────

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

// ─── Mock @nodal-agents/db ────────────────────────────────────────────────────

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

vi.mock('@nodal-agents/db', () => {
  const agents = { telegramBotToken: 'telegram_bot_token', id: 'id' };
  const eq = (col: unknown, val: unknown) => ({ col, val });
  return { agents, eq };
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(overrides: { jobChatId?: string | null; db?: unknown } = {}): ToolContext {
  return {
    jobId: 'job-123',
    agentId: 'agent-abc',
    entityId: 'entity-xyz',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TEST_TOKEN')) as unknown as ToolContext['db'],
  };
}

// A tiny 4-byte fake PNG (enough for size checks)
const TINY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSendImageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTelegramPhotoMock.mockResolvedValue({ messageId: 55 });
    // Default: readFile returns our tiny PNG buffer
    readFileMock.mockResolvedValue(TINY_PNG);
  });

  it('(a) resolves chatId from ctx.jobChatId when no chatId arg provided', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    const result = await tool.execute({ source: '/tmp/output.png' }, ctx);

    expect(sendTelegramPhotoMock).toHaveBeenCalledOnce();
    expect(sendTelegramPhotoMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '99887766', botToken: 'bot:TEST_TOKEN' }),
    );
    expect(result).toEqual({ ok: true, bytes: TINY_PNG.byteLength });
  });

  it('(b) returns tiny { ok, bytes } with no image data in the result', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const result = await tool.execute({ source: '/tmp/output.png' }, ctx);

    // Result must only have ok and bytes — no photo data
    expect(Object.keys(result)).toEqual(['ok', 'bytes']);
    expect(result.ok).toBe(true);
    expect(typeof result.bytes).toBe('number');
    // Specifically: no base64, no Uint8Array, no ArrayBuffer
    expect((result as Record<string, unknown>)['photo']).toBeUndefined();
    expect((result as Record<string, unknown>)['data']).toBeUndefined();
  });

  it('(c) throws no_recipient when no chatId in args or ctx', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: null });

    await expect(tool.execute({ source: '/tmp/output.png' }, ctx)).rejects.toMatchObject({
      name: 'no_recipient',
    });

    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it('(d) throws no_bot_token when agent has no telegramBotToken in DB', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345', db: makeDb(null) });

    await expect(tool.execute({ source: '/tmp/output.png' }, ctx)).rejects.toMatchObject({
      name: 'no_bot_token',
    });

    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it('(e) throws image_too_large when file exceeds 10 MB', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    // Mock readFile to return a 10 MB + 1 byte buffer
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x00);
    readFileMock.mockResolvedValueOnce(bigBuf);

    await expect(tool.execute({ source: '/tmp/huge.png' }, ctx)).rejects.toMatchObject({
      name: 'image_too_large',
    });

    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it('(f) throws fetch_failed on non-2xx URL response', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    // Mock global fetch to return 404
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(
      tool.execute({ source: 'http://127.0.0.1:8188/view?filename=img.png' }, ctx),
    ).rejects.toMatchObject({ name: 'fetch_failed' });

    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('explicit chatId arg overrides ctx.jobChatId', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await tool.execute({ source: '/tmp/out.png', chatId: '11223344' }, ctx);

    expect(sendTelegramPhotoMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '11223344' }),
    );
  });

  it('passes caption to sendTelegramPhoto when provided', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    await tool.execute({ source: '/tmp/out.png', caption: 'My image' }, ctx);

    expect(sendTelegramPhotoMock).toHaveBeenCalledWith(
      expect.objectContaining({ caption: 'My image' }),
    );
  });

  it('has correct static metadata', () => {
    const tool = createSendImageTool();

    expect(tool.name).toBe('send_image');
    expect(tool.riskLevel).toBe('write');
    expect(tool.description).toContain('send_image');
    expect(tool.description).toContain('no_recipient');
    expect(tool.description).toContain('no_bot_token');
  });
});
