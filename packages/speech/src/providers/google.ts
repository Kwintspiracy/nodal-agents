// Google — synthesis and transcription against generativelanguage.googleapis.com.
//
// One vendor covers both halves of the loop with ONE key, which is why it is the
// first provider: an install that already talks to Gemini can speak and listen
// without the user configuring anything new. Proven end to end on 2026-08-11 —
// a French sentence synthesised, the resulting audio fed straight back, and the
// sentence returned word for word.
//
// Two different models, on purpose:
//   - synthesis uses a TTS model, the only line that accepts
//     `responseModalities: ['AUDIO']`: the one the request names (the
//     workspace's voice setting names it, #969), `gemini-2.5-flash-preview-tts`
//     when it names none. Those models are listed by Google's models API
//     (`listModels`), and stream (`synthesizeStream`, below);
//   - transcription uses a normal multimodal model, because Gemini has no
//     dedicated speech-to-text endpoint — audio goes in as an inline part and
//     the instruction asks for a verbatim transcript.
// That second one is a prompt, not an API, so it is written to be as
// uninterpretable as possible: any wording that leaves room for "answer the
// question in the audio" eventually gets an answer instead of a transcript.

import { SpeechError, vendorRefusalCode } from '../errors.ts';
import { pcmToWav, sampleRateFromMimeType } from '../wav.ts';
import type {
  AudioMimeType,
  SpeechAdapter,
  SpeechConnection,
  SpeechModelOffer,
  SpeechStreamChunk,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  Voice,
} from '../speech-adapter.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const STT_MODEL = 'gemini-2.5-flash';

/**
 * Gemini's prebuilt voices. A fixed list, not a network call: the API exposes no
 * "list voices" endpoint, so this IS the catalogue and it has to be maintained
 * by hand when Google changes it. Descriptions are Google's own one-word
 * characterisations, kept verbatim so a picker shows the vendor's vocabulary
 * rather than ours.
 *
 * `languages` is empty by design — these voices are documented as
 * language-agnostic, driven by the language of the text. Writing a list of
 * guessed tags here would be inventing a constraint the vendor does not have.
 */
export const GEMINI_VOICES: readonly Voice[] = [
  { id: 'Zephyr', label: 'Zephyr', languages: [], description: 'Bright' },
  { id: 'Puck', label: 'Puck', languages: [], description: 'Upbeat' },
  { id: 'Charon', label: 'Charon', languages: [], description: 'Informative' },
  { id: 'Kore', label: 'Kore', languages: [], description: 'Firm' },
  { id: 'Fenrir', label: 'Fenrir', languages: [], description: 'Excitable' },
  { id: 'Leda', label: 'Leda', languages: [], description: 'Youthful' },
  { id: 'Orus', label: 'Orus', languages: [], description: 'Firm' },
  { id: 'Aoede', label: 'Aoede', languages: [], description: 'Breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe', languages: [], description: 'Easy-going' },
  { id: 'Autonoe', label: 'Autonoe', languages: [], description: 'Bright' },
  { id: 'Enceladus', label: 'Enceladus', languages: [], description: 'Breathy' },
  { id: 'Iapetus', label: 'Iapetus', languages: [], description: 'Clear' },
  { id: 'Umbriel', label: 'Umbriel', languages: [], description: 'Easy-going' },
  { id: 'Algieba', label: 'Algieba', languages: [], description: 'Smooth' },
  { id: 'Despina', label: 'Despina', languages: [], description: 'Smooth' },
  { id: 'Erinome', label: 'Erinome', languages: [], description: 'Clear' },
  { id: 'Algenib', label: 'Algenib', languages: [], description: 'Gravelly' },
  { id: 'Rasalgethi', label: 'Rasalgethi', languages: [], description: 'Informative' },
  { id: 'Laomedeia', label: 'Laomedeia', languages: [], description: 'Upbeat' },
  { id: 'Achernar', label: 'Achernar', languages: [], description: 'Soft' },
  { id: 'Alnilam', label: 'Alnilam', languages: [], description: 'Firm' },
  { id: 'Schedar', label: 'Schedar', languages: [], description: 'Even' },
  { id: 'Gacrux', label: 'Gacrux', languages: [], description: 'Mature' },
  { id: 'Pulcherrima', label: 'Pulcherrima', languages: [], description: 'Forward' },
  { id: 'Achird', label: 'Achird', languages: [], description: 'Friendly' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi', languages: [], description: 'Casual' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix', languages: [], description: 'Gentle' },
  { id: 'Sadachbia', label: 'Sadachbia', languages: [], description: 'Lively' },
  { id: 'Sadaltager', label: 'Sadaltager', languages: [], description: 'Knowledgeable' },
  { id: 'Sulafat', label: 'Sulafat', languages: [], description: 'Warm' },
];

const VOICE_IDS = new Set(GEMINI_VOICES.map((v) => v.id));

/**
 * Media types this adapter will send. A client intersects its own recording
 * support with this list and picks one, instead of discovering a rejection
 * after the user has already spoken.
 *
 * `audio/webm` is here on MEASUREMENT, not on documentation: Google's page does
 * not list it, and it matters enormously because it is the only container a
 * Chrome MediaRecorder produces. Probed on 2026-08-11 with a real Opus-in-WebM
 * file — HTTP 200, transcription exact, same as ogg and mp4. Taking the doc at
 * its word would have cost the client a WAV re-encode in the browser and five
 * times the upload for every turn.
 *
 * It is also the one entry that could disappear without warning, being
 * undocumented. That is survivable precisely because this list is the single
 * place it is stated: a client that reads `capabilities.accepts` falls back to
 * a documented container on its own the day it stops being offered.
 */
const ACCEPTED_INPUT: readonly AudioMimeType[] = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/mpeg',
  'audio/flac',
  'audio/mp4',
];

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

/** POST to a Gemini model, turning every non-OK answer into one loud error. */
async function callGemini(
  model: string,
  body: unknown,
  connection: SpeechConnection,
): Promise<{ json: GeminiResponse; latencyMs: number }> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await connection.fetch(`${connection.baseURL ?? BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': connection.apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SpeechError(
      'speech_unreachable',
      `google ${model}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const latencyMs = Date.now() - t0;

  let json: GeminiResponse;
  try {
    json = (await res.json()) as GeminiResponse;
  } catch {
    throw new SpeechError(
      'speech_provider_error',
      `google ${model}: HTTP ${res.status} with a body that is not JSON`,
      res.status,
    );
  }
  if (!res.ok) {
    // The vendor's own message is the useful part (quota exhausted, key
    // invalid, model not enabled). Never swallowed, never rewritten.
    throw new SpeechError(
      vendorRefusalCode(res.status),
      `google ${model}: HTTP ${res.status} — ${json.error?.message ?? 'no message'}`,
      res.status,
    );
  }
  return { json, latencyMs };
}

/** The voice is one of Gemini's prebuilt ones: checked before any call, on both paths. */
function validateSynthesis(req: SynthesizeRequest): void {
  if (req.text.trim().length === 0) {
    throw new SpeechError('speech_bad_request', 'synthesize: text is empty');
  }
  // Checked here rather than left to the API: Gemini answers an unknown voice
  // with a generic 400, and the caller would have no way to tell a typo in a
  // voice id from an expired key.
  if (!VOICE_IDS.has(req.voiceId)) {
    throw new SpeechError(
      'speech_bad_request',
      `synthesize: unknown google voice "${req.voiceId}" — listVoices() returns the ${GEMINI_VOICES.length} valid ids`,
    );
  }
}

/** The body both synthesis paths send. `req.style` is not sent: this endpoint
 *  has no style field, and putting it into `text` would have it read aloud. */
function ttsBody(req: SynthesizeRequest): unknown {
  return {
    contents: [{ parts: [{ text: req.text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voiceId } } },
    },
  };
}

/** The vendor's words on a non-OK answer, read once for the stream and the list. */
async function refusal(res: Response, what: string): Promise<SpeechError> {
  const raw = await res.text().catch(() => '');
  let message = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as GeminiResponse | GeminiResponse[];
    // A streamed request refused before its stream answers a JSON array.
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first?.error?.message) message = first.error.message;
  } catch {
    // Not JSON: the raw text is the vendor's words.
  }
  return new SpeechError(
    vendorRefusalCode(res.status),
    `google ${what}: HTTP ${res.status}${message ? ` — ${message}` : ''}`,
    res.status,
  );
}

/** `data:` lines of one Server-Sent Event, joined. */
function eventData(event: string): string {
  return event
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
}

/**
 * The SSE body, event by event, AS IT ARRIVES: an event is yielded the moment
 * its blank line is read, never after the body ends. A body that ends in the
 * middle of an event is said, never read as a shorter reply.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const data = eventData(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (data !== '') yield data;
      }
    }
  } finally {
    // The caller stopped reading (Stop, the reader left): the request is
    // cancelled, so the vendor stops producing what nobody will hear.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
  buffer += decoder.decode();
  if (buffer.trim() !== '') {
    // The last event may end without its blank line; one that does not parse
    // is a cut stream, which `eventAudio` says.
    const data = eventData(buffer);
    if (data === '') {
      throw new SpeechError('speech_provider_error', `google ${model}: the stream was cut`);
    }
    yield data;
  }
}

/**
 * The audio of one event of `streamGenerateContent?alt=sse`.
 *
 * Measured by the orchestrator on 2026-11-03 (`gemini-3.8-flash-tts`,
 * `gemini-3.8-flash-lite-tts`): the first event at 0.78 to 1.13 s, then 88 to
 * 126 events, each a candidate whose part carries base64 audio in
 * `inlineData.data`, `mimeType "audio/l16; rate=24000; channels=1"`.
 *
 * THE BYTES ARE LITTLE-ENDIAN despite the name: `l16` formally means
 * big-endian (RFC 2586), and Google sends little-endian 16-bit samples — the
 * same bytes `generateContent` returns, which this adapter has wrapped in a
 * (little-endian) WAV since August. Verified on a recorded stream: read as
 * little-endian, the mean step between samples is 0.26 of the mean amplitude,
 * a smooth signal; read as big-endian it is 1.26, noise. They pass through
 * untouched as `audio/pcm` (signed 16-bit little-endian), never swapped.
 */
function eventAudio(data: string, model: string): SpeechStreamChunk | null {
  let json: GeminiResponse;
  try {
    json = JSON.parse(data) as GeminiResponse;
  } catch {
    throw new SpeechError(
      'speech_provider_error',
      `google ${model}: a stream event is not JSON, the stream was cut`,
    );
  }
  if (json.error) {
    throw new SpeechError(
      'speech_provider_error',
      `google ${model}: the stream stopped — ${json.error.message ?? 'no message'}`,
    );
  }
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) {
    const reason = json.promptFeedback?.blockReason;
    if (reason) {
      throw new SpeechError('speech_provider_error', `google ${model}: blocked (${reason})`);
    }
    // An event without audio: the closing one carries usage only.
    return null;
  }
  const mimeType = inline.mimeType ?? '';
  const channels = /(?:^|;)\s*channels=(\d+)/i.exec(mimeType);
  if (channels && Number(channels[1]) !== 1) {
    throw new SpeechError(
      'speech_provider_error',
      `google ${model}: the stream is ${mimeType}, where it is read as mono`,
    );
  }
  return {
    audio: Uint8Array.from(Buffer.from(inline.data, 'base64')),
    mimeType: 'audio/pcm',
    sampleRate: sampleRateFromMimeType(mimeType),
  };
}

async function* streamTts(
  req: SynthesizeRequest,
  connection: SpeechConnection,
): AsyncGenerator<SpeechStreamChunk> {
  const model = req.model ?? TTS_MODEL;
  let res: Response;
  try {
    res = await connection.fetch(
      `${connection.baseURL ?? BASE}/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': connection.apiKey },
        body: JSON.stringify(ttsBody(req)),
      },
    );
  } catch (err) {
    throw new SpeechError(
      'speech_unreachable',
      `google ${model}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await refusal(res, model);
  if (!res.body) {
    throw new SpeechError('speech_provider_error', `google ${model}: answered 200 with no body`);
  }

  // Events do not respect sample boundaries: a byte left over is carried into
  // the next event, so every chunk yielded holds whole 16-bit samples.
  let carry: Uint8Array | null = null;
  let total = 0;
  for await (const data of sseEvents(res.body, model)) {
    const piece = eventAudio(data, model);
    if (!piece || piece.audio.byteLength === 0) continue;
    let bytes = piece.audio;
    if (carry) {
      bytes = new Uint8Array(carry.byteLength + piece.audio.byteLength);
      bytes.set(carry, 0);
      bytes.set(piece.audio, carry.byteLength);
      carry = null;
    }
    const whole = bytes.byteLength - (bytes.byteLength % 2);
    if (whole < bytes.byteLength) carry = bytes.slice(whole);
    if (whole === 0) continue;
    total += whole;
    yield {
      audio: bytes.slice(0, whole),
      mimeType: 'audio/pcm',
      ...(piece.sampleRate !== undefined ? { sampleRate: piece.sampleRate } : {}),
    };
  }
  if (carry) {
    throw new SpeechError(
      'speech_provider_error',
      `google ${model}: ${total + carry.byteLength} bytes of 16-bit audio, an odd count: the stream was cut`,
    );
  }
  if (total === 0) {
    throw new SpeechError('speech_provider_error', `google ${model}: the stream carried no audio`);
  }
}

interface GoogleModelsPage {
  models?: { name?: string; displayName?: string }[];
  nextPageToken?: string;
}

/**
 * Google's speech models, as its models API lists them (#969). The list has
 * no "speech output" field: its TTS models are the ones Google names `…-tts`
 * (`gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`), the only mark it
 * carries. It shows them with `generateContent` only, yet
 * `streamGenerateContent` works on them (measured 2026-11-03), so the methods
 * are not filtered on.
 *
 * The voices are Gemini's prebuilt list (`GEMINI_VOICES`): Google serves none.
 * OpenRouter's `supported_voices` for the same models names the same thirty,
 * but reading it would make the Google source depend on an OpenRouter key; the
 * list every request is checked against here is the one that cannot disagree
 * with that check.
 */
async function listTtsModels(connection: SpeechConnection): Promise<readonly SpeechModelOffer[]> {
  const offers: SpeechModelOffer[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${connection.baseURL ?? BASE}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let res: Response;
    try {
      res = await connection.fetch(url.toString(), {
        headers: { 'x-goog-api-key': connection.apiKey },
      });
    } catch (err) {
      throw new SpeechError(
        'speech_unreachable',
        `google models: request failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw await refusal(res, 'models');
    let page: GoogleModelsPage;
    try {
      page = (await res.json()) as GoogleModelsPage;
    } catch {
      throw new SpeechError('speech_provider_error', 'google models: the answer is not JSON');
    }
    for (const m of page.models ?? []) {
      const id = (m.name ?? '').replace(/^models\//, '');
      if (!id.endsWith('-tts')) continue;
      offers.push({ id, label: m.displayName ?? id, voices: GEMINI_VOICES });
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return offers;
}

export const googleSpeechAdapter: SpeechAdapter = {
  provider: 'google',
  requiresKey: true,
  capabilities: {
    // WAV, because this adapter wraps the raw PCM the API returns. Anything
    // that can play a WAV — every browser, every messaging channel — can play
    // what comes out of here.
    outputs: ['audio/wav'],
    dynamicVoices: false,
    // The stream is the raw PCM of each event (#969): signed 16-bit
    // little-endian mono, at the rate each event names (see `eventAudio`).
    streamOutput: 'audio/pcm',
  },

  listVoices(_connection: SpeechConnection): Promise<readonly Voice[]> {
    return Promise.resolve(GEMINI_VOICES);
  },

  listModels(connection: SpeechConnection): Promise<readonly SpeechModelOffer[]> {
    return listTtsModels(connection);
  },

  async synthesize(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): Promise<SynthesizeResult> {
    validateSynthesis(req);
    const model = req.model ?? TTS_MODEL;
    const { json, latencyMs } = await callGemini(model, ttsBody(req), connection);

    const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline?.data || !inline.mimeType) {
      // A 200 with no audio is a real outcome — a safety block, most often.
      // Failing here beats returning zero bytes that play as silence.
      const reason = json.promptFeedback?.blockReason;
      throw new SpeechError(
        'speech_provider_error',
        `google ${model}: answered 200 with no audio` + (reason ? ` (blocked: ${reason})` : ''),
      );
    }

    const sampleRate = sampleRateFromMimeType(inline.mimeType);
    const pcm = Uint8Array.from(Buffer.from(inline.data, 'base64'));
    return {
      audio: pcmToWav(pcm, { sampleRate }),
      mimeType: 'audio/wav',
      sampleRate,
      latencyMs,
    };
  },

  synthesizeStream(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): AsyncIterable<SpeechStreamChunk> {
    validateSynthesis(req);
    return streamTts(req, connection);
  },
};

/**
 * The transcription instruction.
 *
 * Written to leave no room for the model to be helpful. Audio arriving from a
 * push-to-talk button is nearly always a QUESTION, and a model asked loosely to
 * "handle this audio" answers it — so the user says "what time is it in Tokyo"
 * and the chat records "It is 9pm in Tokyo" as what they said. The three
 * sentences below each close one of those doors.
 */
const TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio verbatim. Output only the transcription, with no ' +
  'preamble, no quotation marks and no commentary. Never answer, translate or ' +
  'summarise what is said, even when the audio is a question addressed to you.';

export const googleTranscriptionAdapter: TranscriptionAdapter = {
  provider: 'google',
  requiresKey: true,
  capabilities: { accepts: ACCEPTED_INPUT },

  async transcribe(
    req: TranscribeRequest,
    connection: SpeechConnection,
  ): Promise<TranscribeResult> {
    if (req.audio.length === 0) {
      throw new SpeechError('speech_bad_request', 'transcribe: audio is empty');
    }
    if (!ACCEPTED_INPUT.includes(req.mimeType)) {
      throw new SpeechError(
        'speech_bad_request',
        `transcribe: google does not accept "${req.mimeType}" — it accepts ${ACCEPTED_INPUT.join(', ')}`,
      );
    }

    const prompt = req.language
      ? `${TRANSCRIBE_INSTRUCTION} The audio is in ${req.language}.`
      : TRANSCRIBE_INSTRUCTION;

    const { json, latencyMs } = await callGemini(
      STT_MODEL,
      {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: req.mimeType,
                  data: Buffer.from(req.audio).toString('base64'),
                },
              },
            ],
          },
        ],
      },
      connection,
    );

    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text.length === 0) {
      const reason = json.promptFeedback?.blockReason;
      // A blocked prompt is the vendor refusing; no block is an audio with no words.
      throw new SpeechError(
        reason ? 'speech_provider_error' : 'speech_nothing_heard',
        `google ${STT_MODEL}: answered 200 with no transcript` +
          (reason ? ` (blocked: ${reason})` : ''),
      );
    }
    return { text, latencyMs };
  },
};
