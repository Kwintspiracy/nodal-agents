// telegram-file.test.ts — getTelegramFile: download size cap (F-13)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTelegramFile } from '../channels/telegram.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = 'bot123:ABCDEF';
const FAKE_FILE_ID = 'file-abc';

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch Response whose body streams `totalBytes` in `chunkSize`-byte pieces. */
function streamingResponse(totalBytes: number, chunkSize: number, contentLength?: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return new Response(stream, { status: 200, headers });
}

describe('getTelegramFile — size cap (F-13)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads a normal-sized file successfully', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { file_path: 'photos/a.jpg' } }))
      .mockResolvedValueOnce(streamingResponse(1024, 256, 1024));

    const result = await getTelegramFile(FAKE_TOKEN, FAKE_FILE_ID);
    expect(result.bytes.byteLength).toBe(1024);
    expect(result.ext).toBe('jpg');
  });

  it('refuses a download whose declared Content-Length exceeds the cap', async () => {
    const overCap = 25 * 1024 * 1024; // 25 MB > 20 MB cap
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, result: { file_path: 'documents/huge.bin' } }),
      )
      .mockResolvedValueOnce(streamingResponse(overCap, 1024 * 1024, overCap));

    await expect(getTelegramFile(FAKE_TOKEN, FAKE_FILE_ID)).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_file_too_large';
    });
  });

  it('refuses a download that exceeds the cap in actual bytes even when Content-Length lies (absent/understated)', async () => {
    const overCap = 21 * 1024 * 1024; // just over the 20 MB cap
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, result: { file_path: 'documents/huge.bin' } }),
      )
      // No content-length header at all — the streaming read itself must catch it.
      .mockResolvedValueOnce(streamingResponse(overCap, 1024 * 1024));

    await expect(getTelegramFile(FAKE_TOKEN, FAKE_FILE_ID)).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_file_too_large';
    });
  });
});
