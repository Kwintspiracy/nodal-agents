// send-image.test.ts — createSendImageTool
// Tests:
//   (a) resolves chatId from ctx.jobChatId when no chatId arg
//   (b) returns tiny { ok: true, bytes } shape with NO image data
//   (c) throws no_recipient when no chatId anywhere
//   (d) throws no_bot_token when agent has no token in DB
//   (e) throws image_too_large when bytes exceed 10 MB
//   (f) fetch_failed on non-2xx URL response
//   (g) F1 — explicit chatId authorization (not allowed / allowed / no lookup when === jobChatId)
//   (h) F2 — local source path confinement

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSendImageTool } from '../send-image';
import type { ToolContext } from '../../types';

// ─── Mock @nodal-agents/delivery ─────────────────────────────────────────────
// S3: the tool dispatches through getAdapter(...).sendMedia — mocked here as
// the tool-layer boundary. The adapter's own Telegram wire-format translation
// is covered by packages/delivery/src/tests/telegram-adapter.test.ts.

const { sendMediaMock } = vi.hoisted(() => ({
  sendMediaMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: () => ({ sendMedia: sendMediaMock }),
  };
});

// ─── Mock node:fs/promises ────────────────────────────────────────────────────
// realpath is mocked as an identity pass-through — the confinement check
// (delivery-guard's assertLocalSourceAllowed) then runs for real against the
// OS temp dir / ctx.workspaces / ctx.skillStoreDir, which is why every
// fixture `source` path below lives under `tmpdir()`.

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
    isConversationAllowed: isChatAllowedMock,
    resolveOwnerConversation: resolveOwnerChatIdMock,
  };
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(
  overrides: {
    jobChatId?: string | null;
    db?: unknown;
    resolvedTelegramBotToken?: string;
    workspaces?: ToolContext['workspaces'];
  } = {},
): ToolContext {
  return {
    jobId: 'job-123',
    agentId: 'agent-abc',
    entityId: 'entity-xyz',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TEST_TOKEN')) as unknown as ToolContext['db'],
    resolvedTelegramBotToken: overrides.resolvedTelegramBotToken,
    workspaces: overrides.workspaces,
  };
}

// A tiny 4-byte fake PNG (enough for size checks)
const TINY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Fixture source paths under the OS temp dir — the unconditionally allowed
// root for local sources (F2).
const SRC_OUTPUT = path.join(tmpdir(), 'output.png');
const SRC_HUGE = path.join(tmpdir(), 'huge.png');
const SRC_OUT = path.join(tmpdir(), 'out.png');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSendImageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMediaMock.mockResolvedValue({ messageId: '55' });
    // Default: readFile returns our tiny PNG buffer
    readFileMock.mockResolvedValue(TINY_PNG);
    realpathMock.mockImplementation((p: string) => Promise.resolve(p));
    isChatAllowedMock.mockResolvedValue(true);
    resolveOwnerChatIdMock.mockResolvedValue(null);
  });

  it('(a) resolves chatId from ctx.jobChatId when no chatId arg provided', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    const result = await tool.execute({ source: SRC_OUTPUT }, ctx);

    expect(sendMediaMock).toHaveBeenCalledOnce();
    expect(sendMediaMock).toHaveBeenCalledWith(
      { botToken: 'bot:TEST_TOKEN' },
      '99887766',
      expect.objectContaining({ kind: 'photo' }),
    );
    expect(result).toEqual({ ok: true, bytes: TINY_PNG.byteLength });
  });

  it('(b) returns tiny { ok, bytes } with no image data in the result', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    const result = await tool.execute({ source: SRC_OUTPUT }, ctx);

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

    await expect(tool.execute({ source: SRC_OUTPUT }, ctx)).rejects.toMatchObject({
      name: 'no_recipient',
    });

    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('(d) throws no_bot_token when agent has no telegramBotToken in DB', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345', db: makeDb(null) });

    await expect(tool.execute({ source: SRC_OUTPUT }, ctx)).rejects.toMatchObject({
      name: 'no_bot_token',
    });

    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('(e) throws image_too_large when file exceeds 10 MB', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    // Mock readFile to return a 10 MB + 1 byte buffer
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x00);
    readFileMock.mockResolvedValueOnce(bigBuf);

    await expect(tool.execute({ source: SRC_HUGE }, ctx)).rejects.toMatchObject({
      name: 'image_too_large',
    });

    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('(f) throws fetch_failed on non-2xx URL response', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    // Mock global fetch to return 404
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(
      tool.execute({ source: 'http://127.0.0.1:8188/view?filename=img.png' }, ctx),
    ).rejects.toMatchObject({ name: 'fetch_failed' });

    expect(sendMediaMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('explicit chatId arg overrides ctx.jobChatId (allowed)', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await tool.execute({ source: SRC_OUT, chatId: '11223344' }, ctx);

    expect(sendMediaMock).toHaveBeenCalledWith(expect.anything(), '11223344', expect.anything());
    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-xyz',
      agentId: 'agent-abc',
      channel: 'telegram',
      conversationId: '11223344',
    });
  });

  it('(g) throws telegram_chat_not_allowed for an explicit chatId not on the allow-list', async () => {
    isChatAllowedMock.mockResolvedValueOnce(false);
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await expect(tool.execute({ source: SRC_OUT, chatId: '00000000' }, ctx)).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });

    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('(g) skips the allow-list lookup when the explicit chatId equals ctx.jobChatId', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '99887766' });

    await tool.execute({ source: SRC_OUT, chatId: '99887766' }, ctx);

    expect(isChatAllowedMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith(expect.anything(), '99887766', expect.anything());
  });

  it('(g) delegated worker: resolvedTelegramBotToken + an entity-approved chatId still sends', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: null, resolvedTelegramBotToken: 'root-token' });

    await tool.execute({ source: SRC_OUT, chatId: '55555555' }, ctx);

    expect(sendMediaMock).toHaveBeenCalledWith(
      { botToken: 'root-token' },
      '55555555',
      expect.anything(),
    );
  });

  it('(h) throws source_path_not_allowed for a local path outside workspaces/skill store/temp dir', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    await expect(
      tool.execute({ source: path.join(process.cwd(), '..', 'outside.png') }, ctx),
    ).rejects.toMatchObject({ name: 'source_path_not_allowed' });

    expect(readFileMock).not.toHaveBeenCalled();
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('(h) allows a local path inside a configured workspace root', async () => {
    const wsRoot = path.join(process.cwd(), 'fake-workspace');
    const tool = createSendImageTool();
    const ctx = makeCtx({
      jobChatId: '12345',
      workspaces: [{ label: 'ws', path: wsRoot }],
    });

    await tool.execute({ source: path.join(wsRoot, 'render.png') }, ctx);

    expect(sendMediaMock).toHaveBeenCalledOnce();
  });

  it('passes caption to the adapter when provided', async () => {
    const tool = createSendImageTool();
    const ctx = makeCtx({ jobChatId: '12345' });

    await tool.execute({ source: SRC_OUT, caption: 'My image' }, ctx);

    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
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
