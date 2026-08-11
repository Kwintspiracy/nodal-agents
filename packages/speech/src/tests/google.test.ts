import { describe, it, expect, vi, afterEach } from 'vitest';
import { googleSpeechAdapter, googleTranscriptionAdapter } from '../providers/google.ts';
import { SpeechError } from '../errors.ts';

/**
 * The network is mocked at `fetch`, so what these tests assert is the REQUEST
 * BODY we put on the wire and the DECISION taken on the answer — not that a
 * function was called. The live half of the chain (a real key, real audio) is
 * proven separately by `live-google.test.ts`, which is skipped without a key.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Capture the outgoing request and reply with a canned Gemini response. */
function mockGemini(response: unknown, init: { status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (opts?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(opts?.body)),
    });
    return new Response(JSON.stringify(response), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

/** A minimal valid TTS answer: 100 PCM bytes at 24 kHz. */
function ttsAnswer(bytes = 100, mimeType = 'audio/L16;codec=pcm;rate=24000') {
  return {
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType, data: Buffer.alloc(bytes, 3).toString('base64') } }],
        },
      },
    ],
  };
}

describe('googleSpeechAdapter.synthesize — what goes on the wire', () => {
  it('asks the TTS model for AUDIO with the requested voice', async () => {
    const calls = mockGemini(ttsAnswer());
    await googleSpeechAdapter.synthesize({ text: 'Bonjour', voiceId: 'Kore' }, 'k');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // The TTS line is the only one that accepts responseModalities:['AUDIO'];
    // sending this to a normal model returns text and the feature silently
    // becomes a chatbot.
    expect(call!.url).toContain('gemini-2.5-flash-preview-tts:generateContent');
    const body = call!.body as Record<string, never>;
    expect(body).toMatchObject({
      contents: [{ parts: [{ text: 'Bonjour' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
    });
  });

  it('sends the key in the header, never in the URL', async () => {
    // A key in a query string lands in every proxy log and every referrer.
    const calls = mockGemini(ttsAnswer());
    await googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Puck' }, 'super-secret');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('super-secret');
    expect(calls[0]!.url).not.toContain('super-secret');
  });

  it('returns a playable WAV, not the raw PCM the API sent', async () => {
    mockGemini(ttsAnswer(256));
    const out = await googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Kore' }, 'k');

    expect(out.mimeType).toBe('audio/wav');
    expect(String.fromCharCode(...out.audio.slice(0, 4))).toBe('RIFF');
    expect(out.audio.length).toBe(44 + 256);
    expect(out.sampleRate).toBe(24_000);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('honours the rate the API announced rather than assuming 24 kHz', async () => {
    mockGemini(ttsAnswer(100, 'audio/L16;codec=pcm;rate=16000'));
    const out = await googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Kore' }, 'k');
    expect(out.sampleRate).toBe(16_000);
    expect(new DataView(out.audio.buffer).getUint32(24, true)).toBe(16_000);
  });

  it('rejects an unknown voice BEFORE spending a request', async () => {
    const calls = mockGemini(ttsAnswer());
    await expect(
      googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Gandalf' }, 'k'),
    ).rejects.toThrow(/unknown google voice "Gandalf"/);
    expect(calls).toHaveLength(0);
  });

  it('rejects empty text before spending a request', async () => {
    const calls = mockGemini(ttsAnswer());
    await expect(
      googleSpeechAdapter.synthesize({ text: '   ', voiceId: 'Kore' }, 'k'),
    ).rejects.toThrow(/text is empty/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the vendor’s own message on an error status', async () => {
    // Quota exhausted and invalid key are the two failures a user will
    // actually hit; the vendor's wording is what tells them apart.
    mockGemini({ error: { message: 'Quota exceeded for quota metric' } }, { status: 429 });
    await expect(
      googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Kore' }, 'k'),
    ).rejects.toThrow(/HTTP 429 — Quota exceeded/);
  });

  it('treats a 200 with no audio as a failure, not as silence', async () => {
    mockGemini({ candidates: [{ content: { parts: [{ text: 'I cannot do that' }] } }] });
    const err = await googleSpeechAdapter
      .synthesize({ text: 'x', voiceId: 'Kore' }, 'k')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).code).toBe('speech_provider_error');
    expect((err as SpeechError).message).toMatch(/no audio/);
  });

  it('names the safety block when there is one', async () => {
    mockGemini({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      googleSpeechAdapter.synthesize({ text: 'x', voiceId: 'Kore' }, 'k'),
    ).rejects.toThrow(/blocked: SAFETY/);
  });

  it('exposes voices with stable ids and no invented language claims', async () => {
    const voices = await googleSpeechAdapter.listVoices('k');
    expect(voices.length).toBeGreaterThan(20);
    expect(voices.map((v) => v.id)).toContain('Kore');
    expect(new Set(voices.map((v) => v.id)).size).toBe(voices.length);
    // Gemini's voices are documented as language-agnostic. Listing guessed
    // BCP-47 tags would invent a constraint the vendor does not have.
    expect(voices.every((v) => v.languages.length === 0)).toBe(true);
  });
});

describe('googleTranscriptionAdapter.transcribe', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);
  const textAnswer = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

  it('sends the audio inline with a verbatim-only instruction', async () => {
    const calls = mockGemini(textAnswer('bonjour'));
    await googleTranscriptionAdapter.transcribe({ audio: wav, mimeType: 'audio/wav' }, 'k');

    const body = calls[0]!.body as { contents: { parts: Record<string, never>[] }[] };
    const parts = body.contents[0]!.parts;
    const instruction = String(parts[0]!['text']);
    // Push-to-talk audio is nearly always a question. An instruction that
    // leaves any room gets the ANSWER recorded as what the user said.
    expect(instruction).toMatch(/verbatim/i);
    expect(instruction).toMatch(/never answer/i);
    expect(parts[1]!['inlineData']).toMatchObject({
      mimeType: 'audio/wav',
      data: Buffer.from(wav).toString('base64'),
    });
  });

  it('adds the language hint to the instruction when given', async () => {
    const calls = mockGemini(textAnswer('bonjour'));
    await googleTranscriptionAdapter.transcribe(
      { audio: wav, mimeType: 'audio/wav', language: 'fr-FR' },
      'k',
    );
    const body = calls[0]!.body as { contents: { parts: Record<string, never>[] }[] };
    expect(String(body.contents[0]!.parts[0]!['text'])).toContain('fr-FR');
  });

  it('returns the trimmed transcript', async () => {
    mockGemini(textAnswer('  Bonjour Quentin.\n'));
    const out = await googleTranscriptionAdapter.transcribe(
      { audio: wav, mimeType: 'audio/wav' },
      'k',
    );
    expect(out.text).toBe('Bonjour Quentin.');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses a container Gemini does not accept, before sending', async () => {
    // audio/webm is exactly what a Chrome MediaRecorder produces by default,
    // and exactly what Gemini does not document. Catching it here is the
    // difference between a clear message and an opaque 400.
    const calls = mockGemini(textAnswer('x'));
    await expect(
      googleTranscriptionAdapter.transcribe({ audio: wav, mimeType: 'audio/webm' }, 'k'),
    ).rejects.toThrow(/does not accept "audio\/webm"/);
    expect(calls).toHaveLength(0);
    expect(googleTranscriptionAdapter.capabilities.accepts).not.toContain('audio/webm');
    expect(googleTranscriptionAdapter.capabilities.accepts).toContain('audio/ogg');
  });

  it('refuses empty audio before sending', async () => {
    const calls = mockGemini(textAnswer('x'));
    await expect(
      googleTranscriptionAdapter.transcribe(
        { audio: new Uint8Array(0), mimeType: 'audio/wav' },
        'k',
      ),
    ).rejects.toThrow(/audio is empty/);
    expect(calls).toHaveLength(0);
  });

  it('treats an empty transcript as a failure rather than an empty message', async () => {
    mockGemini(textAnswer('   '));
    await expect(
      googleTranscriptionAdapter.transcribe({ audio: wav, mimeType: 'audio/wav' }, 'k'),
    ).rejects.toThrow(/no transcript/);
  });
});
