// send-file.test.ts — createSendFileTool
// Tests:
//   (a) resolves chatId from ctx.jobChatId; returns { ok, bytes, filename }
//   (b) tiny result shape — NO file data
//   (c) no_recipient when no chatId anywhere
//   (d) no_bot_token when agent has no token in DB
//   (e) file_too_large when bytes exceed 50 MB
//   (f) fetch_failed on non-2xx URL response
//   (g) derives filename from the path, explicit filename overrides

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendFileTool } from '../send-file';
import type { ToolContext } from '../../types';

// ─── Mock @nodal-agents/delivery ─────────────────────────────────────────────

const { sendTelegramDocumentMock } = vi.hoisted(() => ({
  sendTelegramDocumentMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    sendTelegramDocument: sendTelegramDocumentMock,
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

// A tiny fake markdown document.
const TINY_MD = Buffer.from('# Notes\nhello');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSendFileTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTelegramDocumentMock.mockResolvedValue({ messageId: 77 });
    readFileMock.mockResolvedValue(TINY_MD);
  });

  it('(a) resolves chatId from ctx.jobChatId and returns { ok, bytes, filename }', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    const result = await tool.execute({ source: '/tmp/report.md' }, ctx);

    expect(sendTelegramDocumentMock).toHaveBeenCalledOnce();
    expect(sendTelegramDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '99887766',
        botToken: 'bot:TEST_TOKEN',
        filename: 'report.md',
      }),
    );
    expect(result).toEqual({ ok: true, bytes: TINY_MD.byteLength, filename: 'report.md' });
  });

  it('(b) returns a tiny result with no file data', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const result = await tool.execute({ source: '/tmp/report.md' }, ctx);

    expect(Object.keys(result).sort()).toEqual(['bytes', 'filename', 'ok']);
    expect((result as Record<string, unknown>)['document']).toBeUndefined();
    expect((result as Record<string, unknown>)['data']).toBeUndefined();
  });

  it('(c) throws no_recipient when no chatId in args or ctx', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: null });

    await expect(tool.execute({ source: '/tmp/report.md' }, ctx)).rejects.toMatchObject({
      name: 'no_recipient',
    });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(d) throws no_bot_token when agent has no telegramBotToken in DB', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345', db: makeDb(null) });

    await expect(tool.execute({ source: '/tmp/report.md' }, ctx)).rejects.toMatchObject({
      name: 'no_bot_token',
    });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(e) throws file_too_large when file exceeds 50 MB', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const bigBuf = Buffer.alloc(50 * 1024 * 1024 + 1, 0x00);
    readFileMock.mockResolvedValueOnce(bigBuf);

    await expect(tool.execute({ source: '/tmp/huge.zip' }, ctx)).rejects.toMatchObject({
      name: 'file_too_large',
    });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(f) throws fetch_failed on non-2xx URL response', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(
      tool.execute({ source: 'http://127.0.0.1:9000/files/report.pdf' }, ctx),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('(g) explicit filename overrides the derived one', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const result = await tool.execute(
      { source: '/tmp/tmp-xyz.dat', filename: 'Q3-report.pdf' },
      ctx,
    );

    expect(sendTelegramDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'Q3-report.pdf' }),
    );
    expect(result.filename).toBe('Q3-report.pdf');
  });

  it('has correct static metadata', () => {
    const tool = createSendFileTool();
    expect(tool.name).toBe('send_file');
    expect(tool.riskLevel).toBe('write');
    expect(tool.description).toContain('send_file');
    expect(tool.description).toContain('no_recipient');
    expect(tool.description).toContain('file_too_large');
  });
});
