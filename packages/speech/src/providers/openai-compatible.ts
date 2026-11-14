// openai-compatible.ts — a speech or transcription server the USER runs,
// reached at the address they give, by the standard OpenAI audio surface
// (#1048).
//
// Nodal ships no model. A user who runs a Whisper server on their GPU, a
// whisper.cpp server, Speaches, LocalAI or any server that speaks the OpenAI
// audio surface points Nodal at its address (`http://127.0.0.1:8786/v1`), as
// the "LM Studio" LLM source does for text. Three routes, as OpenAI documents
// them, and nothing a particular server adds:
//
//   GET  <address>/models                 { data: [{ id }] }
//   POST <address>/audio/transcriptions   multipart: `file`, `model` → { text }
//   POST <address>/audio/speech           JSON { model, input, voice, response_format } → audio
//
// Transcription is MULTIPART, the OpenAI form. OpenRouter's endpoint takes
// JSON `input_audio` (its own shape, providers/openrouter.ts): a server that
// speaks the OpenAI surface rejects that body, so the two are separate
// adapters, not one with a switch.
//
// WHY NOT THE OFFICIAL SDK (invariant #7). The `openai` package (7.45.1,
// tried on 2026-11-11) refuses to build a client without a credential
// ("Missing credentials…") — a server on the user's machine often asks for
// none, and a placeholder key would be a lie sent on every call — and it
// reads `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
// `OPENAI_BASE_URL` and `OPENAI_CUSTOM_HEADERS` from the environment: a key
// or headers set for OpenAI would travel to the user's server unless each is
// overridden, and the custom headers cannot be turned off. `@ai-sdk/openai`
// (already in the tree) covers transcription and speech but not `/models`
// and not a streamed answer. The three requests are therefore built here,
// with `fetch` and a multipart body written as bytes, as providers/openrouter.ts
// builds its own.
//
// The key is optional (`requiresKey: false`): sent as a bearer token when the
// user gave one, and no `authorization` header at all when they did not.
//
// Nodal never starts nor stops the server. When nothing answers at the
// address, the failure is `speech_unreachable`, said as such: never another
// provider in its place (invariant #4).

import { randomBytes } from 'node:crypto';
import { SpeechError, vendorRefusalCode } from '../errors.ts';
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
  TranscriptionModelOffer,
  Voice,
} from '../speech-adapter.ts';

/** The containers OpenAI's transcription surface documents, as Nodal names them. */
const ACCEPTED_INPUT: readonly AudioMimeType[] = [
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
];

/** The file name the multipart part carries: servers read the container from it. */
const FILE_NAME_BY_MIME: Readonly<Record<string, string>> = {
  'audio/wav': 'audio.wav',
  'audio/mpeg': 'audio.mp3',
  'audio/ogg': 'audio.ogg',
  'audio/flac': 'audio.flac',
  'audio/mp4': 'audio.m4a',
  'audio/webm': 'audio.webm',
};

/**
 * What the speech surface is asked to answer. WAV, because it says its own
 * sample rate: a raw `pcm` answer names none, and servers do not agree on one
 * (24 kHz for some, 22.05 kHz for others), so it would play at the wrong pitch.
 */
const ASKED_OUTPUT: AudioMimeType = 'audio/wav';

function root(connection: SpeechConnection): string {
  if (!connection.baseURL) {
    throw new SpeechError(
      'speech_bad_request',
      'openai-compatible: the connection has no address (a server is reached by the address the user gives)',
    );
  }
  // `http://host:8786/v1/` and `http://host:8786/v1` are the same server.
  return connection.baseURL.replace(/\/+$/, '');
}

/** The bearer token only when the user gave a key: none is ever invented. */
function authHeaders(connection: SpeechConnection): Record<string, string> {
  return connection.apiKey.trim().length > 0
    ? { authorization: `Bearer ${connection.apiKey}` }
    : {};
}

/** The request, or `speech_unreachable` when nothing answered at all. */
async function call(
  connection: SpeechConnection,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await connection.fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    const why =
      typeof cause?.code === 'string'
        ? cause.code
        : err instanceof Error
          ? err.message
          : String(err);
    throw new SpeechError('speech_unreachable', `${url}: ${what}: no answer (${why})`);
  }
}

/** The server's words on a non-OK answer. */
async function refusal(res: Response, url: string): Promise<SpeechError> {
  const body = await res.text().catch(() => '');
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
    else if (typeof parsed.detail === 'string') message = parsed.detail;
  } catch {
    // Not JSON: the raw text is the server's words.
  }
  return new SpeechError(
    vendorRefusalCode(res.status),
    `${url}: HTTP ${res.status}${message ? ` — ${message}` : ''}`,
    res.status,
  );
}

/**
 * The models the server lists at `/models`. A server that has no such route
 * (404, 405, 501) lists none: it answers, and the user types the model name.
 * Any other refusal (a key the server does not accept) is said.
 */
async function listServerModels(connection: SpeechConnection): Promise<readonly { id: string }[]> {
  const url = `${root(connection)}/models`;
  const res = await call(connection, url, { headers: authHeaders(connection) }, 'list models');
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    await res.body?.cancel().catch(() => {});
    return [];
  }
  if (!res.ok) throw await refusal(res, url);
  let json: { data?: unknown };
  try {
    json = (await res.json()) as { data?: unknown };
  } catch {
    throw new SpeechError('speech_provider_error', `${url}: the answer is not JSON`, res.status);
  }
  if (!Array.isArray(json.data)) {
    throw new SpeechError(
      'speech_provider_error',
      `${url}: the answer has no data list`,
      res.status,
    );
  }
  return json.data
    .filter((m): m is { id: string } => typeof (m as { id?: unknown })?.id === 'string')
    .map((m) => ({ id: m.id }));
}

/**
 * The multipart body of a transcription (RFC 7578), written as bytes. This
 * package speaks in bytes and never in a browser's types (architecture test,
 * #948), so it builds the form itself rather than through `FormData`/`Blob`.
 * The boundary is random: 24 bytes of hex cannot appear in what is sent by
 * chance. A model name carrying a line break or a quote would break the
 * part's header: it is refused, never escaped into another name.
 */
export function multipartForm(
  audio: Uint8Array,
  mimeType: string,
  fileName: string,
  model: string,
): { contentType: string; body: Uint8Array<ArrayBuffer> } {
  if (/[\r\n"]/.test(model)) {
    throw new SpeechError(
      'speech_bad_request',
      `transcribe: the model name ${JSON.stringify(model)} cannot be sent in a form`,
    );
  }
  const CRLF = '\r\n';
  const boundary = `nodal-${randomBytes(24).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
      `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    'utf8',
  );
  const tail = Buffer.from(
    `${CRLF}--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
      `${model}${CRLF}--${boundary}--${CRLF}`,
    'utf8',
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new Uint8Array(Buffer.concat([head, audio, tail])),
  };
}

export const openaiCompatibleTranscriptionAdapter: TranscriptionAdapter = {
  provider: 'openai-compatible',
  requiresKey: false,
  capabilities: { accepts: ACCEPTED_INPUT },

  async listModels(connection: SpeechConnection): Promise<readonly TranscriptionModelOffer[]> {
    return (await listServerModels(connection)).map((m) => ({ id: m.id, label: m.id }));
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
        'transcribe: the server needs the model to transcribe with, and Nodal picks none itself',
      );
    }
    const fileName = FILE_NAME_BY_MIME[req.mimeType];
    if (!fileName) {
      throw new SpeechError(
        'speech_bad_request',
        `transcribe: "${req.mimeType}" is not a container of the OpenAI transcription surface (${ACCEPTED_INPUT.join(', ')})`,
      );
    }
    // The OpenAI form: a `file` part and a `model` field, nothing else. The
    // language is not sent, for the reason providers/openrouter.ts gives.
    const form = multipartForm(req.audio, req.mimeType, fileName, req.model);
    const url = `${root(connection)}/audio/transcriptions`;
    const t0 = Date.now();
    const res = await call(
      connection,
      url,
      {
        method: 'POST',
        headers: { 'content-type': form.contentType, ...authHeaders(connection) },
        body: form.body,
      },
      req.model,
    );
    const latencyMs = Date.now() - t0;
    if (!res.ok) throw await refusal(res, url);
    let json: { text?: unknown };
    try {
      json = (await res.json()) as { text?: unknown };
    } catch {
      throw new SpeechError(
        'speech_provider_error',
        `${url}: ${req.model} answered HTTP ${res.status} with a body that is not JSON`,
        res.status,
      );
    }
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (text.length === 0) {
      throw new SpeechError(
        'speech_nothing_heard',
        `${url}: ${req.model} answered with no transcript`,
      );
    }
    return { text, latencyMs };
  },
};

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
      'synthesize: the server needs the model to speak with, and Nodal picks none itself',
    );
  }
}

/** `POST /audio/speech`, answered with audio: the server's refusal and a 200 that is not audio are said here. */
async function openSpeech(
  req: SynthesizeRequest,
  connection: SpeechConnection,
): Promise<{ res: Response; container: AudioMimeType; url: string; t0: number }> {
  const url = `${root(connection)}/audio/speech`;
  const t0 = Date.now();
  // `style` is not sent: the OpenAI surface has no such field, and a server
  // would read a direction written into `input` aloud.
  const res = await call(
    connection,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(connection) },
      body: JSON.stringify({
        model: req.model,
        input: req.text,
        voice: req.voiceId,
        response_format: 'wav',
      }),
    },
    req.model!,
  );
  if (!res.ok) throw await refusal(res, url);
  const contentType = res.headers.get('content-type') ?? '';
  const container = containerOf(contentType, ASKED_OUTPUT);
  // A 200 that is not audio (an error page), or a raw pcm answer whose rate
  // nothing says, is refused rather than played as noise.
  if (container === null || container === 'audio/pcm') {
    await res.body?.cancel().catch(() => {});
    throw new SpeechError(
      'speech_provider_error',
      `${url}: ${req.model} answered ${contentType || 'no content type'}, not audio Nodal plays`,
      res.status,
    );
  }
  return { res, container, url, t0 };
}

export const openaiCompatibleSpeechAdapter: SpeechAdapter = {
  provider: 'openai-compatible',
  requiresKey: false,
  capabilities: {
    outputs: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4'],
    // Servers do not list their voices in a standard way: the user types one.
    dynamicVoices: true,
    // The answer's bytes, as they arrive, in the container the server names
    // (WAV is asked for): the player joins a sentence's chunks and decodes
    // them once the sentence is complete (#968).
    streamOutput: 'audio/wav',
  },

  /** The OpenAI surface has no route that lists voices: none are listed. */
  listVoices(): Promise<readonly Voice[]> {
    return Promise.resolve([]);
  },

  async listModels(connection: SpeechConnection): Promise<readonly SpeechModelOffer[]> {
    return (await listServerModels(connection)).map((m) => ({ id: m.id, label: m.id, voices: [] }));
  },

  async synthesize(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): Promise<SynthesizeResult> {
    validateSynthesis(req);
    const { res, container, url, t0 } = await openSpeech(req, connection);
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength === 0) {
      throw new SpeechError(
        'speech_provider_error',
        `${url}: ${req.model} answered 200 with no audio`,
      );
    }
    return { audio, mimeType: container, latencyMs: Date.now() - t0 };
  },

  synthesizeStream(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): AsyncIterable<SpeechStreamChunk> {
    validateSynthesis(req);
    return (async function* () {
      const { res, container } = await openSpeech(req, connection);
      yield* streamCompressed(res, req.model!, container);
    })();
  },
};
