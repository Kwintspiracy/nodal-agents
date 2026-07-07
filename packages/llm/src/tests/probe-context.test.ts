// probe-context.test.ts — É-3: auto-detecting a local model's context window
// and classifying context-overflow errors.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeContextWindow } from '../probe-context';
import { isContextOverflowError } from '../errors';

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeContextWindow', () => {
  it('returns the LOADED context length from an LM Studio endpoint', async () => {
    mockFetchOnce({
      data: [{ id: 'gemma-3-27b', loaded_context_length: 8192, max_context_length: 32768 }],
    });
    const w = await probeContextWindow({ baseURL: 'http://localhost:1234/v1' });
    expect(w).toBe(8192);
  });

  it('falls back to max_context_length when no loaded value is reported', async () => {
    mockFetchOnce({ data: [{ id: 'm', max_context_length: 4096 }] });
    const w = await probeContextWindow({ baseURL: 'http://localhost:1234/v1' });
    expect(w).toBe(4096);
  });

  it('matches the requested model id among several loaded models', async () => {
    mockFetchOnce({
      data: [
        { id: 'other', loaded_context_length: 2048 },
        { id: 'wanted', loaded_context_length: 65536 },
      ],
    });
    const w = await probeContextWindow({ baseURL: 'http://localhost:1234/v1', model: 'wanted' });
    expect(w).toBe(65536);
  });

  it('hits the host-root native endpoint, not the /v1 base', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await probeContextWindow({ baseURL: 'http://localhost:1234/v1' });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:1234/api/v0/models', expect.anything());
  });

  it('returns null with no baseURL', async () => {
    expect(await probeContextWindow({ baseURL: undefined })).toBeNull();
    expect(await probeContextWindow({ baseURL: '' })).toBeNull();
  });

  it('returns null on a non-ok response or a fetch failure (best-effort)', async () => {
    mockFetchOnce({}, false);
    expect(await probeContextWindow({ baseURL: 'http://localhost:1234/v1' })).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await probeContextWindow({ baseURL: 'http://localhost:1234/v1' })).toBeNull();
  });

  it('returns null when the endpoint reports no usable window', async () => {
    mockFetchOnce({ data: [{ id: 'm' }] });
    expect(await probeContextWindow({ baseURL: 'http://localhost:1234/v1' })).toBeNull();
  });
});

describe('isContextOverflowError', () => {
  it('detects the common provider overflow phrasings', () => {
    for (const msg of [
      "This model's maximum context length is 8192 tokens",
      'context_length_exceeded',
      'The prompt is too long',
      'input exceeds context window',
      'too many tokens in the request',
      'Please reduce the length of your prompt (tokens)',
    ]) {
      expect(isContextOverflowError(new Error(msg)), msg).toBe(true);
    }
  });

  it('does not fire on unrelated errors', () => {
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflowError(new Error('invalid api key'))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});
