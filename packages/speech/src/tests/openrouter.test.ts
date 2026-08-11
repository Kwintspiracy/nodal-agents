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

  it('defaults to the model that is RIGHT on questions, not the fastest', async () => {
    // voxtral was the default for exactly one bench, chosen on a declarative
    // paragraph where it scored 4/4 at 1378 ms. Re-run on short French
    // questions — the only thing anyone says to a voice assistant — it scored
    // 0/6: it answered "Quelle heure est-il à Tokyo ?" in English with an
    // invented time. gemini-2.5-flash is 600 ms slower and 6/6.
    const fn = mockReply('ok');
    await adapter.transcribe({ audio, mimeType: 'audio/wav' }, 'k');
    expect(sentBody(fn).model).toBe('google/gemini-2.5-flash');
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
    // The clause that cost a whole live session: without it, French speech came
    // back as English because the caller was passing the browser's UI locale as
    // the spoken language. Naming the output language RELATIVE to the speech is
    // what makes a wrong hint harmless.
    expect(text).toMatch(/same language as the speech itself/i);
  });

  it('never claims a language, even when the caller insists on one', async () => {
    // The hint is not a clue to these models, it is an order. Measured on
    // French speech: no hint → French; "the audio is in de-DE" → a whole German
    // sentence nobody said. So it is dropped in the adapter, not merely omitted
    // by today's client — that is what stops the next caller reintroducing it.
    for (const language of ['fr-FR', 'en-US', 'de-DE']) {
      const fn = mockReply('ok');
      await adapter.transcribe({ audio, mimeType: 'audio/wav', language }, 'k');
      const text = sentBody(fn).messages[0]!.content.find((c) => c.type === 'text')!.text!;
      expect(text, language).not.toContain(language);
      expect(text, language).not.toMatch(/The audio is in/i);
      vi.unstubAllGlobals();
    }
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
