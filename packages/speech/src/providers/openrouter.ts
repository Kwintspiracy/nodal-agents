// OpenRouter — transcription through the chat-completions surface.
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
// the UI rather than from a commit.
//
// One trap is baked into the instruction below rather than into a comment: on
// the first probe, voxtral was handed French and returned ENGLISH — it
// translated instead of transcribing. It was not a model defect; the terse
// instruction left the door open, and the full wording closes it. Any edit that
// shortens that string must be re-measured against a French sample.

import { SpeechError } from '../errors.ts';
import type {
  AudioMimeType,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
} from '../speech-adapter.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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

  async transcribe(req: TranscribeRequest, apiKey: string): Promise<TranscribeResult> {
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
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
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
        'speech_provider_error',
        `openrouter: HTTP ${res.status} — ${json.error?.message ?? 'no message'}`,
        res.status,
      );
    }

    const raw = json.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) {
      throw new SpeechError('speech_provider_error', 'openrouter: answered 200 with no transcript');
    }
    return { text, latencyMs };
  },
};
