// Google — synthesis and transcription against generativelanguage.googleapis.com.
//
// One vendor covers both halves of the loop with ONE key, which is why it is the
// first provider: an install that already talks to Gemini can speak and listen
// without the user configuring anything new. Proven end to end on 2026-08-11 —
// a French sentence synthesised, the resulting audio fed straight back, and the
// sentence returned word for word.
//
// Two different models, on purpose:
//   - synthesis uses `gemini-2.5-flash-preview-tts`, the only line that accepts
//     `responseModalities: ['AUDIO']`;
//   - transcription uses a normal multimodal model, because Gemini has no
//     dedicated speech-to-text endpoint — audio goes in as an inline part and
//     the instruction asks for a verbatim transcript.
// That second one is a prompt, not an API, so it is written to be as
// uninterpretable as possible: any wording that leaves room for "answer the
// question in the audio" eventually gets an answer instead of a transcript.

import { SpeechError } from '../errors.ts';
import { pcmToWav, sampleRateFromMimeType } from '../wav.ts';
import type {
  AudioMimeType,
  SpeechAdapter,
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
const GOOGLE_VOICES: readonly Voice[] = [
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

const VOICE_IDS = new Set(GOOGLE_VOICES.map((v) => v.id));

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
  apiKey: string,
): Promise<{ json: GeminiResponse; latencyMs: number }> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SpeechError(
      'speech_provider_error',
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
      'speech_provider_error',
      `google ${model}: HTTP ${res.status} — ${json.error?.message ?? 'no message'}`,
      res.status,
    );
  }
  return { json, latencyMs };
}

export const googleSpeechAdapter: SpeechAdapter = {
  provider: 'google',
  capabilities: {
    // WAV, because this adapter wraps the raw PCM the API returns. Anything
    // that can play a WAV — every browser, every messaging channel — can play
    // what comes out of here.
    outputs: ['audio/wav'],
    dynamicVoices: false,
  },

  listVoices(_apiKey: string): Promise<readonly Voice[]> {
    return Promise.resolve(GOOGLE_VOICES);
  },

  async synthesize(req: SynthesizeRequest, apiKey: string): Promise<SynthesizeResult> {
    if (req.text.trim().length === 0) {
      throw new SpeechError('speech_bad_request', 'synthesize: text is empty');
    }
    // Checked here rather than left to the API: Gemini answers an unknown voice
    // with a generic 400, and the caller would have no way to tell a typo in a
    // voice id from an expired key.
    if (!VOICE_IDS.has(req.voiceId)) {
      throw new SpeechError(
        'speech_bad_request',
        `synthesize: unknown google voice "${req.voiceId}" — listVoices() returns the ${GOOGLE_VOICES.length} valid ids`,
      );
    }

    const { json, latencyMs } = await callGemini(
      TTS_MODEL,
      {
        contents: [{ parts: [{ text: req.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voiceId } } },
        },
      },
      apiKey,
    );

    const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline?.data || !inline.mimeType) {
      // A 200 with no audio is a real outcome — a safety block, most often.
      // Failing here beats returning zero bytes that play as silence.
      const reason = json.promptFeedback?.blockReason;
      throw new SpeechError(
        'speech_provider_error',
        `google ${TTS_MODEL}: answered 200 with no audio` + (reason ? ` (blocked: ${reason})` : ''),
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
  capabilities: { accepts: ACCEPTED_INPUT },

  async transcribe(req: TranscribeRequest, apiKey: string): Promise<TranscribeResult> {
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
      apiKey,
    );

    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text.length === 0) {
      const reason = json.promptFeedback?.blockReason;
      throw new SpeechError(
        'speech_provider_error',
        `google ${STT_MODEL}: answered 200 with no transcript` +
          (reason ? ` (blocked: ${reason})` : ''),
      );
    }
    return { text, latencyMs };
  },
};
