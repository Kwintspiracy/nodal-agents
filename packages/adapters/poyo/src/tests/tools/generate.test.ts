// @nodal-agents/adapter-poyo — poyo_generate_image tool tests.
// Mocks the client; asserts on real returned content and submitted arguments.

import { describe, it, expect, vi } from 'vitest';
import { makePoyoGenerateImageTool } from '../../tools/generate.ts';
import { PoyoApiError } from '../../errors.ts';
import type { PoyoClient } from '../../client.ts';
import type { ToolContext } from '@nodal-agents/tools';

const ctx = {} as ToolContext;
// Fast poll for tests — no real waiting.
const FAST = { intervalMs: 0, maxAttempts: 3 };

function makeClient(overrides: Partial<PoyoClient> = {}): PoyoClient {
  return { submit: vi.fn(), status: vi.fn(), ...overrides };
}

describe('makePoyoGenerateImageTool', () => {
  it('exposes the right name and risk level', () => {
    const tool = makePoyoGenerateImageTool(makeClient(), FAST);
    expect(tool.name).toBe('poyo_generate_image');
    expect(tool.riskLevel).toBe('write');
  });

  it('submits model+prompt+size (defaults applied) and returns the finished image URLs', async () => {
    const submit = vi.fn(async () => 'task-1');
    const status = vi.fn(async () => ({
      status: 'finished',
      progress: 100,
      files: [{ url: 'https://x/a.jpg', type: 'image' }],
    }));
    const tool = makePoyoGenerateImageTool(makeClient({ submit, status }), FAST);

    const out = await tool.execute({ prompt: 'a red fox', size: '16:9' }, ctx);

    expect(submit).toHaveBeenCalledWith('gpt-4o-image', { prompt: 'a red fox', size: '16:9' });
    expect(out).toEqual({
      taskId: 'task-1',
      status: 'finished',
      images: ['https://x/a.jpg'],
      model: 'gpt-4o-image',
    });
  });

  it('polls until finished (running → finished)', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', progress: 10, files: [] })
      .mockResolvedValueOnce({
        status: 'finished',
        progress: 100,
        files: [{ url: 'https://x/b.jpg', type: 'image' }],
      });
    const tool = makePoyoGenerateImageTool(
      makeClient({ submit: vi.fn(async () => 't2'), status }),
      FAST,
    );

    const out = await tool.execute({ prompt: 'x' }, ctx);

    expect(status).toHaveBeenCalledTimes(2);
    expect(out.images).toEqual(['https://x/b.jpg']);
  });

  it('honours a custom model and the default size', async () => {
    const submit = vi.fn(async () => 't3');
    const status = vi.fn(async () => ({ status: 'finished', progress: 100, files: [] }));
    const tool = makePoyoGenerateImageTool(makeClient({ submit, status }), FAST);

    const out = await tool.execute({ prompt: 'x', model: 'seedream-4' }, ctx);

    expect(submit).toHaveBeenCalledWith('seedream-4', { prompt: 'x', size: '1:1' });
    expect(out.model).toBe('seedream-4');
  });

  it('throws PoyoApiError(poyo_generation_failed) when the task fails', async () => {
    const status = vi.fn(async () => ({ status: 'failed', progress: 0, files: [] }));
    const tool = makePoyoGenerateImageTool(
      makeClient({ submit: vi.fn(async () => 't4'), status }),
      FAST,
    );

    await expect(tool.execute({ prompt: 'x' }, ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof PoyoApiError && e.code === 'poyo_generation_failed',
    );
  });

  it('returns status "running" with the task id when the bounded poll times out', async () => {
    const status = vi.fn(async () => ({ status: 'running', progress: 50, files: [] }));
    const tool = makePoyoGenerateImageTool(
      makeClient({ submit: vi.fn(async () => 't5'), status }),
      {
        intervalMs: 0,
        maxAttempts: 2,
      },
    );

    const out = await tool.execute({ prompt: 'x' }, ctx);

    expect(out.status).toBe('running');
    expect(out.taskId).toBe('t5');
    expect(out.images).toEqual([]);
    expect(out.note).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);
  });
});
