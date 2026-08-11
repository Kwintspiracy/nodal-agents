import { describe, it, expect, vi, afterEach } from 'vitest';
import { minimaxSpeechAdapter } from '../providers/minimax.ts';
import { isAudioChunk, languageBoostFor } from '../providers/minimax.ts';
import { SpeechError } from '../errors.ts';

/**
 * Build an SSE body from ready-made lines, optionally slicing it at arbitrary
 * byte offsets so a frame straddles two network chunks.
 *
 * That second ability is the point of the helper: a chunk boundary landing
 * mid-line is the normal case on a real connection, not an edge case, and a
 * parser that splits per chunk drops audio at random — which sounds like a
 * glitchy voice, not like a bug, so nobody files it.
 */
function sseBody(lines: string[], cutEvery?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((l) => `${l}\n`).join(''));
  const pieces: Uint8Array[] = [];
  const step = cutEvery ?? bytes.length;
  for (let i = 0; i < bytes.length; i += step) pieces.push(bytes.slice(i, i + step));
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
}

const event = (hex: string, status = 1): string =>
  `data: ${JSON.stringify({ data: { audio: hex, status }, base_resp: { status_code: 0 } })}`;

function mockStream(lines: string[], cutEvery?: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(sseBody(lines, cutEvery), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const req = { text: 'Bonjour.', voiceId: 'French_CasualMan', language: 'fr-FR' };

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of iter) parts.push(c);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('minimax — the end-of-stream summary must not be spoken twice', () => {
  it('drops the status:2 event, which repeats the whole utterance', async () => {
    // MiniMax closes a stream with a summary event carrying a COPY of every byte
    // it already sent. Appending it makes the listener hear the sentence, then
    // hear it again. Nothing in the payload says "duplicate" — it is only
    // visible by adding up the lengths, which is how it was found.
    mockStream([event('aabb'), event('ccdd'), event('aabbccdd', 2)]);
    const audio = await collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'));
    expect([...audio]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('isAudioChunk is the single predicate that decides it', () => {
    expect(isAudioChunk({ data: { audio: 'aa', status: 1 } })).toBe(true);
    expect(isAudioChunk({ data: { audio: 'aa', status: 2 } })).toBe(false);
    expect(isAudioChunk({ data: { audio: '', status: 1 } })).toBe(false);
    expect(isAudioChunk({ data: { status: 1 } })).toBe(false);
    expect(isAudioChunk({})).toBe(false);
  });
});

describe('minimax — wire format', () => {
  it('decodes HEX, not base64', async () => {
    // Base64-decoding this payload yields plausible-looking bytes that are
    // noise: there is no error, only a voice that sounds like static.
    mockStream([event('48656c6c6f')]);
    const audio = await collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'));
    expect(Buffer.from(audio).toString('utf8')).toBe('Hello');
  });

  it('reassembles a frame split across two network chunks', async () => {
    mockStream([event('0102030405060708'), event('090a0b0c')], 7);
    const audio = await collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'));
    expect([...audio]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('sends stream:true, the voice, and the requested model', async () => {
    const fetchMock = vi.fn(async () => new Response(sseBody([event('aa')]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await collect(minimaxSpeechAdapter.synthesizeStream!({ ...req, model: 'speech-02-hd' }, 'k'));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1/t2a_v2');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('speech-02-hd');
    expect(body.voice_setting.voice_id).toBe('French_CasualMan');
    expect(body.language_boost).toBe('French');
    // The key travels in the header, never in the URL — a query string lands in
    // proxy logs and browser history.
    expect(url).not.toContain('k');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');
  });

  it('falls back to the fast model when none is asked for', async () => {
    const fetchMock = vi.fn(async () => new Response(sseBody([event('aa')]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'));
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.model).toBe('speech-02-turbo');
  });
});

describe('minimax — failures are loud', () => {
  it('raises on an error hidden inside a 200', async () => {
    // An invalid key, an unknown voice and an empty balance all arrive as a
    // perfectly successful HTTP response. Code that trusts res.ok reports
    // "no audio" and the user hunts a browser bug for an hour.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            sseBody([
              `data: ${JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })}`,
            ]),
            { status: 200 },
          ),
      ),
    );
    await expect(collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'))).rejects.toThrow(
      /invalid api key/,
    );
  });

  it('raises when the stream is cut off mid-utterance', async () => {
    // The balance can run out BETWEEN frames. Ignoring anything after the first
    // event would truncate the reply in the middle of a word, silently.
    mockStream([
      event('aabb'),
      `data: ${JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })}`,
    ]);
    await expect(collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'))).rejects.toThrow(
      /insufficient balance/,
    );
  });

  it('rejects an empty voiceId instead of picking one of the 332', async () => {
    await expect(
      minimaxSpeechAdapter.synthesize({ text: 'Bonjour.', voiceId: ' ' }, 'k'),
    ).rejects.toMatchObject({ code: 'speech_bad_request' });
  });

  it('rejects empty text', async () => {
    await expect(
      minimaxSpeechAdapter.synthesize({ text: '   ', voiceId: 'French_CasualMan' }, 'k'),
    ).rejects.toBeInstanceOf(SpeechError);
  });

  it('raises when a 200 stream carries no audio at all', async () => {
    mockStream([event('aabb', 2)]); // only the duplicate summary
    await expect(minimaxSpeechAdapter.synthesize(req, 'k')).rejects.toThrow(/no audio/);
  });

  it('surfaces the vendor body on a non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    await expect(collect(minimaxSpeechAdapter.synthesizeStream!(req, 'k'))).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('minimax — language boost', () => {
  it('maps a BCP-47 tag to the vendor’s English language NAME', () => {
    // The vendor takes "French", not "fr", and silently ignores what it does not
    // recognise — so a wrong value costs pronunciation quality with no error.
    expect(languageBoostFor('fr-FR')).toBe('French');
    expect(languageBoostFor('fr')).toBe('French');
    expect(languageBoostFor('fr_FR')).toBe('French');
    expect(languageBoostFor('EN-GB')).toBe('English');
  });

  it('falls back to the vendor’s own detection rather than guessing', () => {
    expect(languageBoostFor(undefined)).toBe('auto');
    expect(languageBoostFor('xx-YY')).toBe('auto');
  });
});

describe('minimax — one-shot path', () => {
  it('concatenates the stream and reports mpeg', async () => {
    mockStream([event('aabb'), event('ccdd')]);
    const result = await minimaxSpeechAdapter.synthesize(req, 'k');
    expect([...result.audio]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.sampleRate).toBe(32_000);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('minimax — voice catalogue', () => {
  it('reads the vendor’s list and tags the language encoded in the id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base_resp: { status_code: 0 },
              system_voice: [
                { voice_id: 'Wise_Woman', voice_name: 'Wise Woman' },
                { voice_id: 'English_Trustworth_Man', voice_name: 'Trustworthy Man' },
                { voice_id: 'French_CasualMan', voice_name: 'Casual Man' },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const voices = await minimaxSpeechAdapter.listVoices('k');
    // Order matters as much as content. The real catalogue is 332 entries with
    // six French ones scattered through it, and on the first live run the user
    // picked an ENGLISH voice to read French — the language was nowhere on
    // screen. Grouped by language, and the language carried in `description`
    // so every picker shows it without knowing anything about MiniMax.
    expect(voices).toEqual([
      {
        id: 'English_Trustworth_Man',
        label: 'Trustworthy Man',
        languages: ['en'],
        description: 'English',
      },
      { id: 'French_CasualMan', label: 'Casual Man', languages: ['fr'], description: 'French' },
      // "Wise" is not a language: no tag is better than a wrong one, and an
      // untagged voice sorts last rather than being dropped.
      { id: 'Wise_Woman', label: 'Wise Woman', languages: [] },
    ]);
  });

  it('raises when the catalogue call fails inside a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'bad key' } }),
            {
              status: 200,
            },
          ),
      ),
    );
    await expect(minimaxSpeechAdapter.listVoices('k')).rejects.toThrow(/bad key/);
  });
});
