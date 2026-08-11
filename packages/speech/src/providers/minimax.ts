// MiniMax — synthesis against the T2A v2 endpoint.
//
// WHY this provider exists at all, when `google` already synthesises: because
// Gemini TTS cannot stream. It returns a finished file, so nothing is audible
// until the whole reply has been rendered — measured at 4.0 s for one short
// sentence, and the user's verdict on that was "I can type faster, it is
// absolutely useless". MiniMax emits MP3 frames as it produces them: measured
// on 2026-08-11, first audible bytes at 516 ms on a three-sentence paragraph and
// 605 ms on a one-liner. The first number does not grow with the length of the
// text, which is the whole property that makes a voice mode feel like a
// conversation rather than a form submission.
//
// It was chosen over the obvious-looking alternative, and the reason is worth
// recording so nobody re-litigates it: OpenRouter carries exactly four models
// that emit audio. Two are Lyria, a MUSIC generator. The other two are
// `openai/gpt-audio` and `gpt-audio-mini`, which are CONVERSATIONAL models, not
// synthesis engines. Probed with an explicit system instruction to read the text
// word for word and never answer it, `gpt-audio-mini` was handed "Oui, je
// t'entends très bien." and said "Parfait, je suis ravi que tu entendes bien. Si
// tu as des questions…". It rewrites what it is asked to speak. Wiring it in
// would have replaced every agent's reply with its own small talk — a defect
// that no unit test would catch and that only shows up in the user's ears.
//
// A real TTS engine reads. That is the distinction this file is built on.

import { SpeechError } from '../errors.ts';
import type {
  AudioMimeType,
  SpeechAdapter,
  SynthesizeRequest,
  SynthesizeResult,
  Voice,
} from '../speech-adapter.ts';

/**
 * MiniMax's own host. Deliberately NOT derived from the `base_url` stored with
 * the user's MiniMax LLM key: that value points at `/anthropic`, the
 * Anthropic-compatible chat surface, and speech lives on a different root. Two
 * unrelated APIs behind one configured string is how a chat-endpoint change
 * silently breaks the voice.
 */
const BASE = 'https://api.minimax.io/v1';

/**
 * The fast line. `speech-02-hd` is the same API with a richer voice and more
 * latency — which is exactly why the model is a per-request field rather than a
 * constant: the trade is the caller's to make, not this file's.
 */
const DEFAULT_MODEL = 'speech-02-turbo';

/** 32 kHz mono MP3. High enough that speech is clean, small enough that the
 *  first frame is on the wire almost immediately. */
const AUDIO_SETTING = {
  sample_rate: 32_000,
  bitrate: 128_000,
  format: 'mp3',
  channel: 1,
} as const;

const STREAM_OUTPUT: AudioMimeType = 'audio/mpeg';

/**
 * BCP-47 → MiniMax's `language_boost` vocabulary.
 *
 * The vendor takes an English language NAME, not a tag, and silently ignores
 * anything it does not recognise — so a wrong value here costs pronunciation
 * quality with no error to notice. Only tags we have a documented name for are
 * mapped; everything else becomes `auto`, which is the vendor's own detection
 * and a defensible answer rather than a guess.
 */
const LANGUAGE_BOOST: Readonly<Record<string, string>> = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  ru: 'Russian',
  tr: 'Turkish',
};

export function languageBoostFor(language: string | undefined): string {
  if (!language) return 'auto';
  // `fr-FR`, `fr_FR` and `fr` must all land on French.
  const primary = language.toLowerCase().split(/[-_]/)[0] ?? '';
  return LANGUAGE_BOOST[primary] ?? 'auto';
}

interface MiniMaxBaseResp {
  status_code?: number;
  status_msg?: string;
}

/**
 * MiniMax answers HTTP 200 and puts the failure in the body.
 *
 * An invalid key, an unknown voice and an exhausted balance all arrive as a
 * perfectly successful response containing `base_resp.status_code != 0`. Code
 * that only checks `res.ok` reads those as an empty stream and reports
 * "no audio" — the user then hunts a bug in the browser while the vendor has
 * been saying "invalid api key" the whole time.
 */
function assertOk(base: MiniMaxBaseResp | undefined, what: string): void {
  if (base && base.status_code !== undefined && base.status_code !== 0) {
    throw new SpeechError(
      'speech_provider_error',
      `minimax ${what}: ${base.status_msg ?? 'unknown error'} (status_code ${base.status_code})`,
    );
  }
}

/** Build the T2A body shared by the streaming and one-shot paths. */
function t2aBody(req: SynthesizeRequest, stream: boolean): unknown {
  return {
    model: req.model ?? DEFAULT_MODEL,
    text: req.text,
    stream,
    language_boost: languageBoostFor(req.language),
    voice_setting: { voice_id: req.voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: AUDIO_SETTING,
  };
}

function validate(req: SynthesizeRequest): void {
  if (req.text.trim().length === 0) {
    throw new SpeechError('speech_bad_request', 'synthesize: text is empty');
  }
  if (req.voiceId.trim().length === 0) {
    // Never defaulted. MiniMax carries 332 system voices; picking one here would
    // make an agent that never chose a voice speak in a stranger's.
    throw new SpeechError('speech_bad_request', 'synthesize: voiceId is empty');
  }
}

async function post(path: string, body: unknown, apiKey: string): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SpeechError(
      'speech_provider_error',
      `minimax ${path}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface T2AEvent {
  data?: { audio?: string; status?: number };
  base_resp?: MiniMaxBaseResp;
}

/**
 * Should this event's payload be appended to the audio?
 *
 * `status: 2` is the vendor's END-OF-STREAM summary, and it carries a COPY of
 * the entire utterance. Appending it doubles every reply — the listener hears
 * the sentence, then hears it again. Nothing in the response says "this is a
 * duplicate"; it is only visible by adding up the byte counts, which is how it
 * was found. This one predicate is the reason this function exists separately
 * and is unit-tested rather than inlined into the loop.
 */
export function isAudioChunk(event: T2AEvent): boolean {
  return (
    typeof event.data?.audio === 'string' && event.data.audio.length > 0 && event.data.status !== 2
  );
}

/**
 * Pull `data:` events out of an SSE byte stream.
 *
 * Written by hand rather than with a library because the framing is the whole
 * job: a chunk boundary lands mid-line often enough that a naive
 * split-per-chunk parser drops audio at random, which sounds like a glitchy
 * voice rather than like a bug.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<T2AEvent> {
  const decoder = new TextDecoder();
  let buffered = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as T2AEvent;
        } catch {
          // A truncated frame is not worth failing a reply over; the next line
          // carries the next slice of audio.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** MiniMax encodes audio as HEX, not base64 — a detail with no error to warn
 *  you: base64-decoding it yields plausible-looking bytes that are noise. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export const minimaxSpeechAdapter: SpeechAdapter = {
  provider: 'minimax',
  capabilities: {
    outputs: ['audio/mpeg'],
    // The catalogue is fetched, not hardcoded: MiniMax carries 332 system
    // voices and lets a user clone their own, so any list written here would be
    // both enormous and wrong.
    dynamicVoices: true,
    streamOutput: STREAM_OUTPUT,
    // Same API, same voices, different trade. Measured 2026-08-11: turbo puts
    // the first sound at ~0.5 s, which is what makes the loop feel like a
    // conversation. HD is the one to pick when the recording matters more than
    // the wait.
    models: [
      {
        id: 'speech-02-turbo',
        label: 'Turbo',
        note: 'Fastest — first sound in about half a second',
      },
      { id: 'speech-02-hd', label: 'HD', note: 'Richer voice, slower to start' },
    ],
  },

  async listVoices(apiKey: string): Promise<readonly Voice[]> {
    const res = await post('/get_voice', { voice_type: 'system' }, apiKey);
    let json: {
      system_voice?: { voice_id?: string; voice_name?: string }[];
      base_resp?: MiniMaxBaseResp;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new SpeechError(
        'speech_provider_error',
        `minimax get_voice: HTTP ${res.status} with a body that is not JSON`,
        res.status,
      );
    }
    assertOk(json.base_resp, 'get_voice');
    if (!res.ok) {
      throw new SpeechError(
        'speech_provider_error',
        `minimax get_voice: HTTP ${res.status}`,
        res.status,
      );
    }

    return (
      (json.system_voice ?? [])
        .filter(
          (v): v is { voice_id: string; voice_name?: string } => typeof v.voice_id === 'string',
        )
        .map((v) => {
          // The vendor encodes the language in the id ("French_CasualMan"),
          // never in a field. Surfacing it is not cosmetic: this catalogue is
          // 332 entries long, the six French ones are scattered through it, and
          // a user picking by name alone lands on an English voice reading
          // French — which is exactly what happened on the first live run.
          const prefix = v.voice_id.split('_')[0] ?? '';
          const tag = Object.entries(LANGUAGE_BOOST).find(([, name]) => name === prefix)?.[0];
          return {
            id: v.voice_id,
            label: v.voice_name ?? v.voice_id,
            languages: tag ? [tag] : [],
            // Shown beside the name by every picker, so the language is read
            // before the choice is made rather than heard after it.
            ...(tag ? { description: prefix } : {}),
          };
        })
        // Grouped by language, then by name. A flat vendor-ordered list buries
        // the handful of voices anyone can actually use.
        .sort(
          (a, b) =>
            (a.languages[0] ?? '￿').localeCompare(b.languages[0] ?? '￿') ||
            a.label.localeCompare(b.label),
        )
    );
  },

  async synthesize(req: SynthesizeRequest, apiKey: string): Promise<SynthesizeResult> {
    validate(req);
    const t0 = Date.now();
    // The one-shot path drains the streaming one rather than calling the
    // non-streaming endpoint: one code path, one set of vendor quirks, and a
    // caller that cannot stream (a voice note on a messaging channel) still
    // benefits from the audio being produced progressively upstream.
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamChunks(req, apiKey)) {
      parts.push(chunk);
      total += chunk.length;
    }
    if (total === 0) {
      throw new SpeechError('speech_provider_error', 'minimax t2a_v2: stream carried no audio');
    }
    const audio = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      audio.set(p, offset);
      offset += p.length;
    }
    return {
      audio,
      mimeType: 'audio/mpeg',
      sampleRate: AUDIO_SETTING.sample_rate,
      latencyMs: Date.now() - t0,
    };
  },

  synthesizeStream(req: SynthesizeRequest, apiKey: string): AsyncIterable<Uint8Array> {
    validate(req);
    return streamChunks(req, apiKey);
  },
};

async function* streamChunks(req: SynthesizeRequest, apiKey: string): AsyncGenerator<Uint8Array> {
  const res = await post('/t2a_v2', t2aBody(req, true), apiKey);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new SpeechError(
      'speech_provider_error',
      `minimax t2a_v2: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
      res.status,
    );
  }
  for await (const event of sseEvents(res.body)) {
    // Checked on EVERY event, not just the first: the vendor can interrupt a
    // stream mid-utterance (balance exhausted between frames), and swallowing
    // that would cut the reply off silently in the middle of a word.
    assertOk(event.base_resp, 't2a_v2');
    if (isAudioChunk(event)) yield hexToBytes(event.data!.audio!);
  }
}
