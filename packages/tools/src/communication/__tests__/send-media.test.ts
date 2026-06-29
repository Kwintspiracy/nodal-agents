// send-media.test.ts — createSendVideoTool / createSendAudioTool / createSendVoiceTool
// The three share one factory; tests cover the shared core via send_video plus
// per-tool wiring (right name + right delivery helper).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendVideoTool, createSendAudioTool, createSendVoiceTool } from '../send-media';
import type { ToolContext } from '../../types';

const { videoMock, audioMock, voiceMock } = vi.hoisted(() => ({
  videoMock: vi.fn(),
  audioMock: vi.fn(),
  voiceMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    sendTelegramVideo: videoMock,
    sendTelegramAudio: audioMock,
    sendTelegramVoice: voiceMock,
  };
});

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }));

vi.mock('@nodal-agents/db', () => {
  const agents = { telegramBotToken: 'telegram_bot_token', id: 'id' };
  const eq = (col: unknown, val: unknown) => ({ col, val });
  return { agents, eq };
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

function makeCtx(overrides: { jobChatId?: string | null; db?: unknown } = {}): ToolContext {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    entityId: 'entity-1',
    jobChatId: overrides.jobChatId ?? null,
    db: (overrides.db ?? makeDb('bot:TOKEN')) as unknown as ToolContext['db'],
  };
}

const TINY = Buffer.from([0x00, 0x01, 0x02, 0x03]);

describe('send media tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    videoMock.mockResolvedValue({ messageId: 1 });
    audioMock.mockResolvedValue({ messageId: 2 });
    voiceMock.mockResolvedValue({ messageId: 3 });
    readFileMock.mockResolvedValue(TINY);
  });

  it('exposes the right names and risk levels', () => {
    expect(createSendVideoTool().name).toBe('send_video');
    expect(createSendAudioTool().name).toBe('send_audio');
    expect(createSendVoiceTool().name).toBe('send_voice');
    expect(createSendVideoTool().riskLevel).toBe('write');
  });

  it('send_video uploads via sendTelegramVideo and returns { ok, bytes, filename }', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    const result = await createSendVideoTool().execute({ source: '/tmp/clip.mp4' }, ctx);

    expect(videoMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '4242', botToken: 'bot:TOKEN', filename: 'clip.mp4' }),
    );
    expect(result).toEqual({ ok: true, bytes: TINY.byteLength, filename: 'clip.mp4' });
  });

  it('send_audio routes to sendTelegramAudio; send_voice routes to sendTelegramVoice', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    await createSendAudioTool().execute({ source: '/tmp/song.mp3' }, ctx);
    await createSendVoiceTool().execute({ source: '/tmp/note.ogg' }, ctx);

    expect(audioMock).toHaveBeenCalledWith(expect.objectContaining({ filename: 'song.mp3' }));
    expect(voiceMock).toHaveBeenCalledWith(expect.objectContaining({ filename: 'note.ogg' }));
  });

  it('throws no_recipient when no chatId anywhere', async () => {
    const ctx = makeCtx({ jobChatId: null });
    await expect(
      createSendVideoTool().execute({ source: '/tmp/clip.mp4' }, ctx),
    ).rejects.toMatchObject({
      name: 'no_recipient',
    });
    expect(videoMock).not.toHaveBeenCalled();
  });

  it('throws no_bot_token when the agent has no token', async () => {
    const ctx = makeCtx({ jobChatId: '4242', db: makeDb(null) });
    await expect(
      createSendAudioTool().execute({ source: '/tmp/song.mp3' }, ctx),
    ).rejects.toMatchObject({
      name: 'no_bot_token',
    });
    expect(audioMock).not.toHaveBeenCalled();
  });

  it('throws video_too_large past the 50 MB cap', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    readFileMock.mockResolvedValueOnce(Buffer.alloc(50 * 1024 * 1024 + 1, 0));
    await expect(
      createSendVideoTool().execute({ source: '/tmp/huge.mp4' }, ctx),
    ).rejects.toMatchObject({
      name: 'video_too_large',
    });
    expect(videoMock).not.toHaveBeenCalled();
  });

  it('explicit filename overrides the derived name', async () => {
    const ctx = makeCtx({ jobChatId: '4242' });
    await createSendVideoTool().execute({ source: '/tmp/tmp.bin', filename: 'final-cut.mp4' }, ctx);
    expect(videoMock).toHaveBeenCalledWith(expect.objectContaining({ filename: 'final-cut.mp4' }));
  });
});
