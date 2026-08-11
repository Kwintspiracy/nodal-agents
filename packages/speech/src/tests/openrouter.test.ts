import { describe, it, expect, vi, afterEach } from 'vitest';
import { openrouterTranscriptionAdapter as adapter } from '../providers/openrouter.ts';

function mockReply(content: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const audio = new Uint8Array([1, 2, 3, 4]);

function sentBody(fn: ReturnType<typeof vi.fn>): {
  model: string;
  messages: { content: { type: string; text?: string; input_audio?: { format: string } }[] }[];
} {
  const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe('openrouter — WebM is refused on purpose', () => {
  it('does not accept audio/webm', () => {
    // Chrome's MediaRecorder emits WebM/Opus by default, so the obvious client
    // design sends exactly the container voxtral rejects (probed: HTTP 400,
    // "Failed to load audio file"). Declaring it here would move that failure
    // from a clear 415 before the upload to a vendor error after the user has
    // already spoken.
    expect(adapter.capabilities.accepts).not.toContain('audio/webm');
  });

  it('rejects it before spending a network call', async () => {
    const fn = mockReply('should never be called');
    await expect(adapter.transcribe({ audio, mimeType: 'audio/webm' }, 'k')).rejects.toMatchObject({
      code: 'speech_bad_request',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts the containers that were actually proven to work', async () => {
    for (const mime of ['audio/wav', 'audio/ogg', 'audio/mpeg'] as const) {
      expect(adapter.capabilities.accepts).toContain(mime);
    }
  });
});

describe('openrouter — the request it builds', () => {
  it('names the container in the vendor’s short form', async () => {
    for (const [mime, format] of [
      ['audio/wav', 'wav'],
      ['audio/ogg', 'ogg'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp4', 'm4a'],
      ['audio/flac', 'flac'],
    ] as const) {
      const fn = mockReply('ok');
      await adapter.transcribe({ audio, mimeType: mime }, 'k');
      const part = sentBody(fn).messages[0]!.content.find((c) => c.type === 'input_audio');
      expect(part!.input_audio!.format, mime).toBe(format);
      vi.unstubAllGlobals();
    }
  });

  it('defaults to voxtral — fastest and steadiest of the three measured routes', async () => {
    const fn = mockReply('ok');
    await adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k');
    expect(sentBody(fn).model).toBe('mistralai/voxtral-small-24b-2507');
  });

  it('uses the model it is given, so the choice can live in the UI', async () => {
    const fn = mockReply('ok');
    await adapter.transcribe(
      { audio, mimeType: 'audio/wav', model: 'google/gemini-2.5-flash' },
      'k',
    );
    expect(sentBody(fn).model).toBe('google/gemini-2.5-flash');
  });

  it('forbids translating, answering and summarising — all three', async () => {
    // On the first probe this model was handed French and returned ENGLISH: it
    // translated instead of transcribing. The model was not at fault, the terse
    // instruction was. Each clause here closes a door that was seen standing
    // open, so shortening this string must be re-measured, not assumed safe.
    const fn = mockReply('ok');
    await adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k');
    const text = sentBody(fn).messages[0]!.content.find((c) => c.type === 'text')!.text!;
    expect(text).toMatch(/verbatim/i);
    expect(text).toMatch(/never answer, translate or summarise/i);
    expect(text).toMatch(/even when the audio is a question/i);
  });

  it('passes the language hint through', async () => {
    const fn = mockReply('ok');
    await adapter.transcribe({ audio, mimeType: 'audio/wav', language: 'fr-FR' }, 'k');
    const text = sentBody(fn).messages[0]!.content.find((c) => c.type === 'text')!.text!;
    expect(text).toContain('fr-FR');
  });

  it('carries the key in the header, never in the URL', async () => {
    const fn = mockReply('ok');
    await adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'secret-key');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret-key');
  });
});

describe('openrouter — what it returns and what it refuses', () => {
  it('trims the transcript and reports how long it took', async () => {
    mockReply('  Ajoute du lait à la liste de courses.  ');
    const r = await adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k');
    expect(r.text).toBe('Ajoute du lait à la liste de courses.');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('raises rather than returning an empty transcript', async () => {
    // An empty string would be recorded as "the user said nothing" and sent to
    // the agent as a blank turn — worse than an error, because it looks normal.
    mockReply('   ');
    await expect(adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k')).rejects.toThrow(
      /no transcript/,
    );
  });

  it('raises on empty audio without calling the vendor', async () => {
    const fn = mockReply('never');
    await expect(
      adapter.transcribe({ audio: new Uint8Array(), mimeType: 'audio/wav' }, 'k'),
    ).rejects.toMatchObject({ code: 'speech_bad_request' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes the vendor’s own words through on a failure', async () => {
    // "Failed to load audio file" and "insufficient credits" are the two things
    // a user can act on; a generic "transcription failed" is unactionable.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Failed to load audio file' } }), {
            status: 400,
          }),
      ),
    );
    await expect(adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k')).rejects.toMatchObject({
      code: 'speech_provider_error',
      status: 400,
      message: expect.stringContaining('Failed to load audio file'),
    });
  });
});
