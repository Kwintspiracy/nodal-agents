// send-media.test.ts — createSendVideoTool / createSendAudioTool / createSendVoiceTool
// The three share one factory; tests cover the shared core via send_video plus
// per-tool wiring (right name + right delivery helper), plus F1/F2 wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSendVideoTool, createSendAudioTool, createSendVoiceTool } from '../send-media';
import type { ToolContext } from '../../types';

// S3: the tools dispatch through getAdapter(...).sendMedia — mocked here as
// the tool-layer boundary. The adapter's own Telegram wire-format translation
// is covered by packages/delivery/src/tests/telegram-adapter.test.ts. One
// shared mock, since all three tools go through the same adapter method —
// per-tool wiring is asserted via the `kind` field in the media argument.
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

// realpath is mocked as an identity pass-through — the confinement check then
// runs for real, hence every fixture source path lives under `tmpdir()`.
const { readFileMock, realpathMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  realpathMock: vi.fn((p: string) => Promise.resolve(p)),
}));
vi.mock('node:fs/promises', () => ({ readFile: readFileMock, realpath: realpathMock }));

const { isChatAllowedMock, resolveOwnerChatIdMock } = vi.hoisted(() => ({
  isChatAllowedMock: vi.fn(),
  resolveOwnerChatIdMock: vi.fn(),
}));

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

function makeCtx(
  overrides: {
    jobChatId?: string | null;
    db?: unknown;
    workspaces?: ToolContext['workspaces'];
  } = {},
): ToolContext {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    entityId: 'entity-1',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TOKEN')) as unknown as ToolContext['db'],
    workspaces: overrides.workspaces,
  };
}

const TINY = Buffer.from([0x00, 0x01, 0x02, 0x03]);

// Fixture source paths under the OS temp dir (F2's unconditionally allowed root).
const SRC_CLIP = path.join(tmpdir(), 'clip.mp4');
const SRC_SONG = path.join(tmpdir(), 'song.mp3');
const SRC_NOTE = path.join(tmpdir(), 'note.ogg');
const SRC_HUGE = path.join(tmpdir(), 'huge.mp4');
const SRC_TMP_BIN = path.join(tmpdir(), 'tmp.bin');

describe('send media tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMediaMock.mockResolvedValue({ messageId: '1' });
    readFileMock.mockResolvedValue(TINY);
    realpathMock.mockImplementation((p: string) => Promise.resolve(p));
    isChatAllowedMock.mockResolvedValue(true);
    resolveOwnerChatIdMock.mockResolvedValue(null);
  });

  it('exposes the right names and risk levels', () => {
    expect(createSendVideoTool().name).toBe('send_video');
    expect(createSendAudioTool().name).toBe('send_audio');
    expect(createSendVoiceTool().name).toBe('send_voice');
    expect(createSendVideoTool().riskLevel).toBe('write');
  });

  it('send_video uploads via the adapter with kind "video" and returns { ok, bytes, filename }', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    const result = await createSendVideoTool().execute({ source: SRC_CLIP }, ctx);

    expect(sendMediaMock).toHaveBeenCalledWith(
      { botToken: 'bot:TOKEN' },
      '4242',
      expect.objectContaining({ kind: 'video', filename: 'clip.mp4' }),
    );
    expect(result).toEqual({ ok: true, bytes: TINY.byteLength, filename: 'clip.mp4' });
  });

  it('send_audio uploads with kind "audio"; send_voice uploads with kind "voice"', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    await createSendAudioTool().execute({ source: SRC_SONG }, ctx);
    await createSendVoiceTool().execute({ source: SRC_NOTE }, ctx);

    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'audio', filename: 'song.mp3' }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'voice', filename: 'note.ogg' }),
    );
  });

  it('throws no_recipient when no chatId anywhere', async () => {
    const ctx = makeCtx({ jobChatId: null });
    await expect(createSendVideoTool().execute({ source: SRC_CLIP }, ctx)).rejects.toMatchObject({
      name: 'no_recipient',
    });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('throws no_bot_token when the agent has no token', async () => {
    const ctx = makeCtx({ jobChatId: '4242', db: makeDb(null) });
    await expect(createSendAudioTool().execute({ source: SRC_SONG }, ctx)).rejects.toMatchObject({
      name: 'no_bot_token',
    });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('throws video_too_large past the 50 MB cap', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    readFileMock.mockResolvedValueOnce(Buffer.alloc(50 * 1024 * 1024 + 1, 0));
    await expect(createSendVideoTool().execute({ source: SRC_HUGE }, ctx)).rejects.toMatchObject({
      name: 'video_too_large',
    });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('explicit filename overrides the derived name', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    await createSendVideoTool().execute({ source: SRC_TMP_BIN, filename: 'final-cut.mp4' }, ctx);
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ filename: 'final-cut.mp4' }),
    );
  });

  it('throws telegram_chat_not_allowed for an explicit chatId not on the allow-list', async () => {
    isChatAllowedMock.mockResolvedValueOnce(false);
    const ctx = makeCtx({ jobChatId: '4242' });

    await expect(
      createSendVideoTool().execute({ source: SRC_CLIP, chatId: '00000000' }, ctx),
    ).rejects.toMatchObject({ name: 'telegram_chat_not_allowed' });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it('skips the allow-list lookup when the explicit chatId equals ctx.jobChatId', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });

    await createSendVideoTool().execute({ source: SRC_CLIP, chatId: '4242' }, ctx);

    expect(isChatAllowedMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith(expect.anything(), '4242', expect.anything());
  });

  it('throws source_path_not_allowed for a local path outside workspaces/skill store/temp dir', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });

    await expect(
      createSendVideoTool().execute({ source: path.join(process.cwd(), '..', 'outside.mp4') }, ctx),
    ).rejects.toMatchObject({ name: 'source_path_not_allowed' });

    expect(readFileMock).not.toHaveBeenCalled();
    expect(sendMediaMock).not.toHaveBeenCalled();
  });
});
