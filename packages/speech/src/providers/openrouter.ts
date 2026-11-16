// OpenRouter — transcription through the transcription surface
// (`/audio/transcriptions`), and synthesis through the speech surface
// (`/audio/speech`, further down).
//
// LISTENING (#976). Until then a CHAT model (`google/gemini-2.5-flash` on
// `/chat/completions`) was asked, by an instruction, to write down what it
// heard: 2.2 to 3.9 s per real turn on the owner's stack, and a prompt rather
// than a recogniser (the August benches, in git history, show chat models
// answering a question instead of transcribing it). OpenRouter now serves a
// dedicated endpoint: `POST /audio/transcriptions` takes `model` and
// `input_audio: { data, format }` and answers `{ text, usage }`.
//
// Measured by the orchestrator on 2026-11-03 (synthetic clips of 6 to 7 s,
// English and French, up to six runs each, exactness = word error rate):
//
//   x-ai/grok-stt-1.0                     median 0.89 s   exact 6/6
//   openai/gpt-transcribe                 median 0.98 s   exact 6/6
//   chat:google/gemini-2.5-flash (before) median 2.47 s   exact 6/6
//   deepgram/nova-3                       median 1.74 s   French: EMPTY text
//
// The chat path is REMOVED, not kept beside the endpoint: `google/gemini-2.5-flash`
// is not a model of the endpoint (400 "Model google/gemini-2.5-flash does not
// exist", measured 2026-11-03), so it could not be one more choice of the same
// mechanism. One mechanism. `x-ai/grok-stt-1.0` transcribed the questions word
// for word and never answered them ("Quelle heure est-il à Tokyo ?", 2/2).
//
// Which model transcribes is never decided here: the request names it (the
// workspace's voice setting, #976), and the models come from OpenRouter
// (`listModels`, `GET /models?output_modalities=transcription`).

import { SpeechError, vendorRefusalCode } from '../errors.ts';
import { pcmToWav } from '../wav.ts';
import { containerOf, streamCompressed } from './audio-answer.ts';
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
  TranscriptionModelOffer,
  Voice,
} from '../speech-adapter.ts';

/** OpenRouter's API root. A key stored with its own base URL (a proxy) passes
 *  it as `SpeechConnection.baseURL`, and both surfaces below hang off it. */
const BASE = 'https://openrouter.ai/api/v1';

/**
 * Containers this adapter will send.
 *
 * `audio/webm` is absent: Chrome's MediaRecorder emits WebM/Opus by default,
 * and recognisers behind the same endpoint do not all take it. The client
 * captures raw PCM from its AudioContext and wraps it as WAV instead, the only
 * form that behaves identically across browsers (and the one measured on
 * `x-ai/grok-stt-1.0`: 16 kHz mono PCM16 WAV, 2026-11-03).
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

interface TranscriptionResponse {
  text?: unknown;
  error?: { message?: string };
}

const capabilities: TranscriptionCapabilities = { accepts: ACCEPTED_INPUT };

/** The models OpenRouter serves for transcription now. */
async function listTranscriptionModels(
  connection: SpeechConnection,
): Promise<readonly TranscriptionModelOffer[]> {
  let res: Response;
  try {
    res = await connection.fetch(
      `${connection.baseURL ?? BASE}/models?output_modalities=transcription`,
      { headers: { authorization: `Bearer ${connection.apiKey}` } },
    );
  } catch (err) {
    throw new SpeechError(
      'speech_unreachable',
      `openrouter transcription models: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await refusal(res, 'transcription models');
  let json: { data?: Array<{ id?: string; name?: string }> };
  try {
    json = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
  } catch {
    throw new SpeechError(
      'speech_provider_error',
      'openrouter transcription models: the answer is not JSON',
    );
  }
  if (!Array.isArray(json.data)) {
    throw new SpeechError(
      'speech_provider_error',
      'openrouter transcription models: the answer has no data',
    );
  }
  return json.data
    .filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: m.name ?? m.id }));
}

export const openrouterTranscriptionAdapter: TranscriptionAdapter = {
  provider: 'openrouter',
  requiresKey: true,
  capabilities,

  listModels(connection: SpeechConnection): Promise<readonly TranscriptionModelOffer[]> {
    return listTranscriptionModels(connection);
  },

  async transcribe(
    req: TranscribeRequest,
    connection: SpeechConnection,
  ): Promise<TranscribeResult> {
    if (req.audio.length === 0) {
      throw new SpeechError('speech_bad_request', 'transcribe: audio is empty');
    }
    if (!req.model || req.model.trim().length === 0) {
      throw new SpeechError(
        'speech_bad_request',
        'transcribe: openrouter needs the model to transcribe with, and picks none itself',
      );
    }
    const format = FORMAT_BY_MIME[req.mimeType];
    if (!format) {
      throw new SpeechError(
        'speech_bad_request',
        `transcribe: openrouter does not accept "${req.mimeType}" — it accepts ${ACCEPTED_INPUT.join(', ')}`,
      );
    }

    // `req.language` is DELIBERATELY not sent. Nodal does not know the
    // language the person speaks: the browser's interface locale is not it
    // (a whole session was once transcribed, and answered, in English over
    // French speech because of it). The endpoint's recognisers detect the
    // language themselves; one that cannot without a hint (Deepgram nova-3
    // answers empty text in French) is refused when it is chosen, by the
    // sample check of the voice setting, instead of being fed a guess.
    const t0 = Date.now();
    let res: Response;
    try {
      res = await connection.fetch(`${connection.baseURL ?? BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          input_audio: { data: Buffer.from(req.audio).toString('base64'), format },
        }),
      });
    } catch (err) {
      throw new SpeechError(
        'speech_unreachable',
        `openrouter ${req.model}: request failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const latencyMs = Date.now() - t0;
    // The vendor's own words are the useful part ("Failed to load audio file",
    // "insufficient credits"), masked by SpeechError like every vendor word.
    if (!res.ok) throw await refusal(res, req.model);

    let json: TranscriptionResponse;
    try {
      json = (await res.json()) as TranscriptionResponse;
    } catch {
      throw new SpeechError(
        'speech_provider_error',
        `openrouter ${req.model}: HTTP ${res.status} with a body that is not JSON`,
        res.status,
      );
    }
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (text.length === 0) {
      // Words or no words is a fact about the audio, not a vendor failure: the
      // caller says "nothing heard", and still never records an empty turn.
      throw new SpeechError(
        'speech_nothing_heard',
        `openrouter ${req.model}: answered 200 with no transcript`,
      );
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
      'speech_unreachable',
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
): Promise<{
  res: Response;
  model: string;
  contentType: string;
  container: AudioMimeType;
  t0: number;
}> {
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
      'speech_unreachable',
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
  // The container is the ANSWER's (#969): pcm is asked for, and most models
  // answer it, but MiniMax answers mp3 only (measured 2026-11-03). Its bytes
  // travel as what they are, with their media type, and the player decodes
  // them; they are never wrapped into a WAV of mp3 bytes nor read as samples,
  // which would play as noise. A container nothing here names is refused.
  const container = containerOf(contentType, 'audio/pcm');
  if (container === null) {
    await res.body?.cancel().catch(() => {});
    throw new SpeechError(
      'speech_provider_error',
      `${model} answered ${contentType}, a container Nodal does not play`,
      res.status,
    );
  }
  return { res, model, contentType, container, t0 };
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
  const { res, model, contentType, container } = await openSpeech(req, connection);
  if (container !== 'audio/pcm') {
    yield* streamCompressed(res, model, container);
    return;
  }
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
      yield { audio: bytes.slice(0, whole), mimeType: 'audio/pcm', sampleRate };
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
  requiresKey: true,
  capabilities: {
    // WAV, because the one-shot path wraps the raw PCM the API returns.
    // WAV for a pcm answer; any other container is returned as the model answered it (#969).
    outputs: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4'],
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
    const { res, model, contentType, container, t0 } = await openSpeech(req, connection);
    const pcm = new Uint8Array(await res.arrayBuffer());
    const latencyMs = Date.now() - t0;
    if (pcm.byteLength === 0) {
      throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
    }
    // A compressed answer (#969) is already a file: it is returned as what it is.
    if (container !== 'audio/pcm') return { audio: pcm, mimeType: container, latencyMs };
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
