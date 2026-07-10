// send-file.test.ts — createSendFileTool
// Tests:
//   (a) resolves chatId from ctx.jobChatId; returns { ok, bytes, filename }
//   (b) tiny result shape — NO file data
//   (c) no_recipient when no chatId anywhere
//   (d) no_bot_token when agent has no token in DB
//   (e) file_too_large when bytes exceed 50 MB
//   (f) fetch_failed on non-2xx URL response
//   (g) derives filename from the path, explicit filename overrides
//   (h) F1 — explicit chatId authorization
//   (i) F2 — local source path confinement

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
// realpath is mocked as an identity pass-through — the confinement check
// then runs for real, hence every fixture source path lives under `tmpdir()`.

const { readFileMock, realpathMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  realpathMock: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  realpath: realpathMock,
}));

// ─── Mock @nodal-agents/db ────────────────────────────────────────────────────

const { isChatAllowedMock, resolveOwnerChatIdMock } = vi.hoisted(() => ({
  isChatAllowedMock: vi.fn(),
  resolveOwnerChatIdMock: vi.fn(),
}));

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
  return {
    agents,
    eq,
    isChatAllowed: isChatAllowedMock,
    resolveOwnerChatId: resolveOwnerChatIdMock,
  };
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(
  overrides: {
    jobChatId?: string | null;
    db?: unknown;
    workspaces?: ToolContext['workspaces'];
  } = {},
): ToolContext {
  return {
    jobId: 'job-123',
    agentId: 'agent-abc',
    entityId: 'entity-xyz',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TEST_TOKEN')) as unknown as ToolContext['db'],
    workspaces: overrides.workspaces,
  };
}

// A tiny fake markdown document.
const TINY_MD = Buffer.from('# Notes\nhello');

// Fixture source paths under the OS temp dir (F2's unconditionally allowed root).
const SRC_REPORT = path.join(tmpdir(), 'report.md');
const SRC_HUGE = path.join(tmpdir(), 'huge.zip');
const SRC_TMP_XYZ = path.join(tmpdir(), 'tmp-xyz.dat');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSendFileTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTelegramDocumentMock.mockResolvedValue({ messageId: 77 });
    readFileMock.mockResolvedValue(TINY_MD);
    realpathMock.mockImplementation((p: string) => Promise.resolve(p));
    isChatAllowedMock.mockResolvedValue(true);
    resolveOwnerChatIdMock.mockResolvedValue(null);
  });

  it('(a) resolves chatId from ctx.jobChatId and returns { ok, bytes, filename }', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    const result = await tool.execute({ source: SRC_REPORT }, ctx);

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

    const result = await tool.execute({ source: SRC_REPORT }, ctx);

    expect(Object.keys(result).sort()).toEqual(['bytes', 'filename', 'ok']);
    expect((result as Record<string, unknown>)['document']).toBeUndefined();
    expect((result as Record<string, unknown>)['data']).toBeUndefined();
  });

  it('(c) throws no_recipient when no chatId in args or ctx', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: null });

    await expect(tool.execute({ source: SRC_REPORT }, ctx)).rejects.toMatchObject({
      name: 'no_recipient',
    });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(d) throws no_bot_token when agent has no telegramBotToken in DB', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345', db: makeDb(null) });

    await expect(tool.execute({ source: SRC_REPORT }, ctx)).rejects.toMatchObject({
      name: 'no_bot_token',
    });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(e) throws file_too_large when file exceeds 50 MB', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const bigBuf = Buffer.alloc(50 * 1024 * 1024 + 1, 0x00);
    readFileMock.mockResolvedValueOnce(bigBuf);

    await expect(tool.execute({ source: SRC_HUGE }, ctx)).rejects.toMatchObject({
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

    const result = await tool.execute({ source: SRC_TMP_XYZ, filename: 'Q3-report.pdf' }, ctx);

    expect(sendTelegramDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'Q3-report.pdf' }),
    );
    expect(result.filename).toBe('Q3-report.pdf');
  });

  it('(h) throws telegram_chat_not_allowed for an explicit chatId not on the allow-list', async () => {
    isChatAllowedMock.mockResolvedValueOnce(false);
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await expect(
      tool.execute({ source: SRC_REPORT, chatId: '00000000' }, ctx),
    ).rejects.toMatchObject({ name: 'telegram_chat_not_allowed' });
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
  });

  it('(h) skips the allow-list lookup when the explicit chatId equals ctx.jobChatId', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await tool.execute({ source: SRC_REPORT, chatId: '99887766' }, ctx);

    expect(isChatAllowedMock).not.toHaveBeenCalled();
    expect(sendTelegramDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '99887766' }),
    );
  });

  it('(i) throws source_path_not_allowed for a local path outside workspaces/skill store/temp dir', async () => {
    const tool = createSendFileTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    await expect(
      tool.execute({ source: path.join(process.cwd(), '..', 'outside.md') }, ctx),
    ).rejects.toMatchObject({ name: 'source_path_not_allowed' });

    expect(readFileMock).not.toHaveBeenCalled();
    expect(sendTelegramDocumentMock).not.toHaveBeenCalled();
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
