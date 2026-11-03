// OpenRouter — transcription through the chat-completions surface, and
// synthesis through the speech surface (`/audio/speech`, further down).
//
// WHY route listening through OpenRouter when `google` already transcribes:
// because it is two and a half times faster and, more importantly, correct.
// Measured on 2026-08-11, same audio file, four passes each, same instruction:
//
//   google direct  gemini-2.5-flash   median 3543 ms   [2885, 3068, 3543, 3938]   exact 2/4
//   openrouter     gemini-2.5-flash   median 7842 ms   [1496, 1790, 7842, 11708]  exact 4/4
//   openrouter     voxtral-small      median 1378 ms   [1181, 1292, 1378, 1866]   exact 4/4
//
// Two things in that table are worth more than the headline. First, the model
// we shipped originally gets the transcript WRONG half the time — it dropped a
// word and truncated a sentence — and a single pass would never have shown it.
// Second, the SAME model behind OpenRouter swings from 1.5 s to 11.7 s, because
// the router picks among upstreams; median latency alone would have made it look
// acceptable. Voxtral is both the fastest and the steadiest, so it is the
// default, and the model stays a per-request field so this can be revisited from
// the UI rather than from a commit. (Superseded the next day, on questions: see
// DEFAULT_MODEL below. The table is kept because it is why the model is a field.)
//
// One trap is baked into the instruction below rather than into a comment: on
// the first probe, voxtral was handed French and returned ENGLISH — it
// translated instead of transcribing. It was not a model defect; the terse
// instruction left the door open, and the full wording closes it. Any edit that
// shortens that string must be re-measured against a French sample.

import { SpeechError, vendorRefusalCode } from '../errors.ts';
import { pcmToWav } from '../wav.ts';
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
  TranscriptionCapabilities,
  Voice,
} from '../speech-adapter.ts';

/** OpenRouter's API root. A key stored with its own base URL (a proxy) passes
 *  it as `SpeechConnection.baseURL`, and both surfaces below hang off it. */
const BASE = 'https://openrouter.ai/api/v1';

/**
 * Chosen on the case that actually occurs, after a first choice that was made on
 * the case that was easy to test.
 *
 * The first bench used a declarative PARAGRAPH and voxtral scored 4/4 at
 * 1378 ms, so it shipped. In a voice mode nearly every utterance is a QUESTION,
 * and re-run on short French questions — six passes, 2026-08-12 — the table
 * reversed completely:
 *
 *   OR voxtral-small        median  940 ms   exact 0/6
 *   OR gemini-2.5-flash     median 1491 ms   exact 6/6
 *   OR gemini-2.5-flash-lite median 1460 ms  exact 0/6   (drops words)
 *   google direct 2.5-flash median 2931 ms   exact 3/6   (drops "à Tokyo")
 *
 * Voxtral is not merely imprecise there: asked to transcribe "Quelle heure
 * est-il à Tokyo ?" it ANSWERED, in English, with an invented time — Voxtral
 * Small is a conversational audio model, not a recogniser, and no wording of
 * the instruction below held it. 600 ms slower and right every time beats
 * fastest and wrong.
 */
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/**
 * Containers this adapter will send.
 *
 * `audio/webm` is ABSENT, and its absence is the load-bearing part: Chrome's
 * MediaRecorder emits WebM/Opus by default, so the obvious client design sends
 * exactly the one container voxtral rejects — probed, HTTP 400, "Failed to load
 * audio file". Gemini accepts WebM and voxtral does not, so this list is the
 * INTERSECTION rather than the union: the model is a per-request field, and a
 * capability that only holds for some models is not a capability.
 *
 * The consequence is deliberate and lives in the client: it captures raw PCM
 * from the AudioContext it already has open for silence detection and wraps it
 * as WAV, instead of relying on whatever the browser's recorder happens to
 * produce. That is also the only form that behaves identically across browsers.
 */
const ACCEPTED_INPUT: readonly AudioMimeType[] = [
  'audio/wav',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/flac',
];

/** OpenRouter names the container in a short `format` field of its own rather
 *  than taking the media type. */
const FORMAT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
};

/**
 * The transcription instruction — see the file header.
 *
 * Every sentence closes a door that was observed standing open: the first
 * closes "answer the question you heard", the second closes "translate it", the
 * third closes "tidy it up". Audio from a push-to-talk button is nearly always
 * a question, and a model asked loosely will answer it, so the user says "what
 * time is it in Tokyo" and the chat records "It is 9pm in Tokyo" as their words.
 */
const TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio verbatim. Output only the transcription, with no ' +
  'preamble, no quotation marks and no commentary. Never answer, translate or ' +
  'summarise what is said, even when the audio is a question addressed to you. ' +
  // The last sentence names the OUTPUT language relative to the speech instead
  // of naming an input language nobody knows. Without it, French in came back
  // as English out on a live install for a whole session: the caller was
  // passing the BROWSER's UI locale as `language`, so the prompt read "the
  // audio is in en-US" over French speech and the model obliged.
  'Write the transcription in the same language as the speech itself, never in ' +
  'any other language.';

interface ChatResponse {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: string };
}

const capabilities: TranscriptionCapabilities = { accepts: ACCEPTED_INPUT };

export const openrouterTranscriptionAdapter: TranscriptionAdapter = {
  provider: 'openrouter',
  capabilities,

  async transcribe(
    req: TranscribeRequest,
    connection: SpeechConnection,
  ): Promise<TranscribeResult> {
    if (req.audio.length === 0) {
      throw new SpeechError('speech_bad_request', 'transcribe: audio is empty');
    }
    const format = FORMAT_BY_MIME[req.mimeType];
    if (!format) {
      throw new SpeechError(
        'speech_bad_request',
        `transcribe: openrouter does not accept "${req.mimeType}" — it accepts ${ACCEPTED_INPUT.join(', ')}`,
      );
    }

    // `req.language` is DELIBERATELY not put into the prompt, and this is the
    // most important line in the file.
    //
    // These models do not read a language hint as "here is a clue about the
    // speaker"; they read it as "produce this language". Measured 2026-08-12 on
    // French speech, three passes each: no hint → French 3/3; "the audio is in
    // en-US" → English; "the audio is in de-DE" → German, an entire sentence
    // invented in a language nobody spoke. Strengthening the instruction did
    // not hold it, which is why this is a code decision and not a wording one.
    //
    // The bug this prevents ran for a whole live session: the browser client
    // passed `navigator.language` — the language of the browser's INTERFACE,
    // not of the person speaking — so every French turn was stored, and
    // answered, in English. The client no longer sends it; ignoring it here as
    // well is what makes it impossible for the next caller to do it again.
    //
    // Not a silent fallback (invariant #4): nothing is being guessed. A claim
    // that measurably corrupts the output is refused, and the model detects the
    // spoken language on its own — which is the accurate answer, not a
    // degraded one.
    const prompt = TRANSCRIBE_INSTRUCTION;

    const t0 = Date.now();
    let res: Response;
    try {
      res = await connection.fetch(`${connection.baseURL ?? BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model ?? DEFAULT_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'input_audio',
                  input_audio: { data: Buffer.from(req.audio).toString('base64'), format },
                },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      throw new SpeechError(
        'speech_provider_error',
        `openrouter: request failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const latencyMs = Date.now() - t0;

    let json: ChatResponse;
    try {
      json = (await res.json()) as ChatResponse;
    } catch {
      throw new SpeechError(
        'speech_provider_error',
        `openrouter: HTTP ${res.status} with a body that is not JSON`,
        res.status,
      );
    }
    if (!res.ok) {
      // OpenRouter nests the upstream vendor's own words under `metadata.raw`,
      // and those words are the useful part ("Failed to load audio file",
      // "insufficient credits"). Passing the whole message through beats
      // summarising it into something unactionable.
      throw new SpeechError(
        vendorRefusalCode(res.status),
        `openrouter: HTTP ${res.status} — ${json.error?.message ?? 'no message'}`,
        res.status,
      );
    }

    const raw = json.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) {
      // Words or no words is a fact about the audio, not a vendor failure: the
      // caller says "nothing heard", and still never records an empty turn.
      throw new SpeechError('speech_nothing_heard', 'openrouter: answered 200 with no transcript');
    }
    return { text, latencyMs };
  },
};

// ── Synthesis ────────────────────────────────────────────────────────────────
//
// The August note in providers/minimax.ts ("OpenRouter carries exactly four
// models that emit audio", none of them a reader) was true when it was written.
// On 2026-09-23 OpenRouter opened dedicated text-to-speech models on
// `POST /api/v1/audio/speech`, compatible with OpenAI's Audio Speech API. Read
// off OpenRouter on 2026-09-25 (`GET /api/v1/models/<id>/endpoints`): both
// models below answered `"modality": "text->speech"`, context 8192 tokens,
// provider Google AI Studio. These read their input; they do not converse.
// This is the path `generate_speech` has used since #487, moved here from
// packages/llm so that one speech path remains (#940).
//
// Gemini 3.8 TTS reads `input` verbatim: a delivery direction written into the
// text is spoken aloud. OpenRouter takes the style as
// `provider.options["google-ai-studio"].speech_metadata.style` instead (docs:
// guides/overview/multimodal/tts, "Google (Gemini TTS)").

// WHICH MODEL AND WHICH VOICE is never decided here (#969). Until then this
// file held a list of two Gemini models and a default voice (`Kore`), and the
// whole platform spoke with the first of each. The models and their voices are
// now read from OpenRouter itself (`listModels`, the models API and each
// model's `supported_voices`), and the request always names both: the caller
// reads them from the workspace's voice setting. Every model except Gemini
// refuses a request with no voice ("An explicit voice is required for this
// TTS provider.", measured 2026-11-03).

/** One speech model as `GET /models?output_modalities=speech` lists it. */
interface OpenRouterModel {
  id?: string;
  name?: string;
  /** Absent or null: OpenRouter names no voice for this model. */
  supported_voices?: string[] | null;
}

/**
 * The speech models OpenRouter serves now, each with the voices it lists for
 * it. The list is public; the key is sent anyway, so a proxy stored with the
 * key (its `baseURL`) answers for the models it actually routes.
 */
async function listSpeechModels(
  connection: SpeechConnection,
): Promise<readonly SpeechModelOffer[]> {
  let res: Response;
  try {
    res = await connection.fetch(`${connection.baseURL ?? BASE}/models?output_modalities=speech`, {
      headers: { authorization: `Bearer ${connection.apiKey}` },
    });
  } catch (err) {
    throw new SpeechError(
      'speech_provider_error',
      `openrouter models: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await refusal(res, 'models');
  let json: { data?: OpenRouterModel[] };
  try {
    json = (await res.json()) as { data?: OpenRouterModel[] };
  } catch {
    throw new SpeechError('speech_provider_error', 'openrouter models: the answer is not JSON');
  }
  if (!Array.isArray(json.data)) {
    throw new SpeechError('speech_provider_error', 'openrouter models: the answer has no data');
  }
  return json.data
    .filter((m): m is OpenRouterModel & { id: string } => typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      voices: (Array.isArray(m.supported_voices) ? m.supported_voices : []).map((v) => ({
        id: v,
        label: v,
        languages: [],
      })),
    }));
}

/** The vendor's words on a non-OK answer (unknown voice, no credit). */
async function refusal(res: Response, what: string): Promise<SpeechError> {
  const detail = await res.text().catch(() => '');
  let message = detail.slice(0, 300);
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Not JSON: the raw text is the vendor's words.
  }
  return new SpeechError(
    vendorRefusalCode(res.status),
    `openrouter ${what}: HTTP ${res.status}${message ? ` — ${message}` : ''}`,
    res.status,
  );
}

/**
 * Gemini TTS answers raw PCM: signed 16-bit little-endian, mono, 24 kHz, as
 * Google documents its speech output. Used when the answer's content type
 * names no rate: this is the vendor's documented format, not a guess, and it
 * is how the path has behaved since #487.
 */
export const GEMINI_TTS_SAMPLE_RATE = 24_000;

/**
 * `audio/pcm;rate=16000` → 16000; no rate named → the Gemini default. Only a
 * `rate` PARAMETER counts: `bitrate=64000` is not a sample rate (review of
 * PR #489).
 */
function sampleRateOf(contentType: string): number {
  const match = /(?:^|;)\s*rate=(\d+)/i.exec(contentType);
  return match ? Number(match[1]) : GEMINI_TTS_SAMPLE_RATE;
}

/** `channels=2` → 2; none named → mono, as Gemini documents its output. */
function channelsOf(contentType: string): number {
  const match = /(?:^|;)\s*channels=(\d+)/i.exec(contentType);
  return match ? Number(match[1]) : 1;
}

/** The request body `/audio/speech` gets. Exported for its test. */
export function speechBody(req: SynthesizeRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: req.text,
    voice: req.voiceId,
    // Gemini TTS through OpenRouter only answers pcm: "Gemini TTS only
    // supports response_format=\"pcm\". Got \"mp3\"." (run 16052ae6,
    // 2026-09-25).
    response_format: 'pcm',
  };
  const style = req.style?.trim();
  // The style field is Google AI Studio's. Another vendor's model gets no
  // Google option rather than one it would refuse.
  if (style && model.startsWith('google/')) {
    body['provider'] = { options: { 'google-ai-studio': { speech_metadata: { style } } } };
  }
  return body;
}

/** What both synthesis paths check before reading a single audio byte. */
function validateSynthesis(req: SynthesizeRequest): void {
  if (req.text.trim().length === 0) {
    throw new SpeechError('speech_bad_request', 'synthesize: text is empty');
  }
  if (req.voiceId.trim().length === 0) {
    throw new SpeechError('speech_bad_request', 'synthesize: voiceId is empty');
  }
  if (!req.model || req.model.trim().length === 0) {
    throw new SpeechError(
      'speech_bad_request',
      'synthesize: openrouter needs the model to speak with, and picks none itself',
    );
  }
}

/**
 * The request to `/audio/speech`, answered with audio headers: the vendor's
 * refusal and a 200 that is not audio are said here, once, for both paths.
 */
async function openSpeech(
  req: SynthesizeRequest,
  connection: SpeechConnection,
): Promise<{ res: Response; model: string; contentType: string; t0: number }> {
  // The voice is not checked here: the caller checked it against the model's
  // `supported_voices` when the setting was chosen, and OpenRouter's own
  // refusal names the voice when a list has moved since.
  const model = req.model!;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await connection.fetch(`${connection.baseURL ?? BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.apiKey}`,
      },
      body: JSON.stringify(speechBody(req, model)),
    });
  } catch (err) {
    throw new SpeechError(
      'speech_provider_error',
      `openrouter ${model}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) throw await refusal(res, model);

  const contentType = res.headers.get('content-type') ?? '';
  // A 200 whose body is not audio (an error page) is said, never wrapped
  // into a broken file. An answer naming no type at all is taken as the pcm
  // it was asked for: the odd-length check still catches a cut stream.
  if (contentType !== '' && !/^audio\//i.test(contentType)) {
    throw new SpeechError(
      'speech_provider_error',
      `${model} answered ${contentType}, not audio`,
      res.status,
    );
  }
  // Every path reads the body as the pcm it asked for. A model that answers
  // another container (MiniMax answers mp3 only, measured 2026-11-03) is said,
  // never wrapped into a WAV of mp3 bytes nor streamed as samples, which
  // would play as noise. Playing it needs the container to travel with the
  // audio, end to end: not done yet, and refused until it is (#969).
  if (contentType !== '' && !/^audio\/(?:pcm|l16)\b/i.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new SpeechError(
      'speech_provider_error',
      `${model} answered ${contentType}, where Nodal reads pcm from this route: this model cannot speak here yet`,
      res.status,
    );
  }
  return { res, model, contentType, t0 };
}

/**
 * The PCM as it arrives (#943). Network chunks do not respect sample
 * boundaries: a byte left over is carried into the next chunk, so every
 * chunk yielded holds whole 16-bit samples. A byte still left at the end is a
 * cut stream, said as such.
 *
 * Whether the vendor sends its body progressively is the vendor's: measured
 * by the orchestrator on 2026-11-03 through OpenRouter, three passes each,
 * the Gemini 3.8 TTS models (today's default) do NOT — first byte at 2.0 to
 * 3.3 s, the whole body within 10 ms after it — while Deepgram aura-2 (first
 * byte 0.84 s, 87 to 110 chunks) and Mistral voxtral (0.83 to 1.23 s) do.
 * The read is the same either way; the caller times it.
 */
async function* streamPcm(
  req: SynthesizeRequest,
  connection: SpeechConnection,
): AsyncGenerator<SpeechStreamChunk> {
  const { res, model, contentType } = await openSpeech(req, connection);
  // The rate is the ANSWER's, read from its content type, never assumed
  // (one OpenRouter model answers pcm at 44 100 Hz). A layout the samples
  // cannot be played as — more than one channel — is refused, never guessed.
  const sampleRate = sampleRateOf(contentType);
  const channels = channelsOf(contentType);
  if (channels !== 1) {
    await res.body?.cancel().catch(() => {});
    throw new SpeechError(
      'speech_provider_error',
      `${model} answered ${contentType}: ${channels} channels, where the stream is mono`,
    );
  }
  if (!res.body) {
    throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
  }
  const reader = res.body.getReader();
  let carry: Uint8Array | null = null;
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value.byteLength === 0) continue;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(carry.byteLength + value.byteLength);
        bytes.set(carry, 0);
        bytes.set(value, carry.byteLength);
        carry = null;
      }
      const whole = bytes.byteLength - (bytes.byteLength % 2);
      if (whole < bytes.byteLength) carry = bytes.slice(whole);
      if (whole === 0) continue;
      total += whole;
      yield { audio: bytes.slice(0, whole), sampleRate };
    }
  } finally {
    // The caller stopped reading (the person said Stop, the reader left): the
    // answer is cancelled, so the vendor stops sending what nobody will hear.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
  if (carry) {
    throw new SpeechError(
      'speech_provider_error',
      `${model} answered ${total + carry.byteLength} bytes of 16-bit audio: an odd count, the stream was cut`,
    );
  }
  if (total === 0) {
    throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
  }
}

export const openrouterSpeechAdapter: SpeechAdapter = {
  provider: 'openrouter',
  capabilities: {
    // WAV, because the one-shot path wraps the raw PCM the API returns.
    outputs: ['audio/wav'],
    // The models and their voices are OpenRouter's, read at runtime (#969).
    dynamicVoices: true,
    // The stream is the raw PCM itself (#943): signed 16-bit little-endian,
    // mono, at the rate the answer names. The body of `/audio/speech` is read
    // as it arrives; whether the vendor sends it progressively is the
    // vendor's (see `streamPcm`), and the caller measures it by timing the
    // first chunk, as this interface promises.
    streamOutput: 'audio/pcm',
  },

  /** Every voice OpenRouter lists, across its speech models. A voice belongs
   *  to a model: `listModels` says which. */
  async listVoices(connection: SpeechConnection): Promise<readonly Voice[]> {
    const seen = new Map<string, Voice>();
    for (const m of await listSpeechModels(connection)) {
      for (const v of m.voices) if (!seen.has(v.id)) seen.set(v.id, v);
    }
    return [...seen.values()];
  },

  listModels(connection: SpeechConnection): Promise<readonly SpeechModelOffer[]> {
    return listSpeechModels(connection);
  },

  async synthesize(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): Promise<SynthesizeResult> {
    validateSynthesis(req);
    const { res, model, contentType, t0 } = await openSpeech(req, connection);
    const pcm = new Uint8Array(await res.arrayBuffer());
    const latencyMs = Date.now() - t0;
    if (pcm.byteLength === 0) {
      throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
    }
    // 16-bit samples come in pairs of bytes: an odd count is a cut stream, and
    // its WAV would be malformed (review of PR #489).
    if (pcm.byteLength % 2 !== 0) {
      throw new SpeechError(
        'speech_provider_error',
        `${model} answered ${pcm.byteLength} bytes of 16-bit audio: an odd count, the stream was cut`,
      );
    }
    const sampleRate = sampleRateOf(contentType);
    return { audio: pcmToWav(pcm, { sampleRate }), mimeType: 'audio/wav', sampleRate, latencyMs };
  },

  synthesizeStream(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): AsyncIterable<SpeechStreamChunk> {
    validateSynthesis(req);
    return streamPcm(req, connection);
  },
};
