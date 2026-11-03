// speech-adapter.ts — provider-neutral voice surface.
//
// WHY this exists, and why it is TWO interfaces rather than one "voice" object:
// the product wants voice in four places that share almost nothing — a
// push-to-talk control in the dashboard, voice notes on messaging channels, a
// continuous conversation, and eventually a phone call. What they DO share is
// exactly two operations: turn text into audio, and turn audio into text. Those
// are the seams, so those are the interfaces. Everything above them (transport,
// UI, channel) composes them; nothing below them knows what they are for.
//
// The shape deliberately mirrors `ChannelAdapter` in @nodal-agents/delivery: one
// interface per capability, a `capabilities` object a caller can branch on, and
// a registry that FAILS LOUD on an unknown provider rather than falling back to
// a default (invariant #4). That similarity is not decoration — it is the same
// problem (many vendors, one caller) already solved once in this codebase.

/**
 * Voice vendors. Adding one means adding a member here, a provider module, and
 * a registry entry — nothing else changes shape.
 *
 * The first two are the ones whose credentials a Nodal install is likely to
 * already hold: `google` covers BOTH synthesis and transcription with a single
 * key (proven end to end on 2026-08-11 — synthesised French, fed the audio back,
 * got the sentence returned word for word), and `minimax` is the vendor with
 * interchangeable and cloneable voices. Local engines (Piper, Kokoro, a
 * whisper.cpp server) are the obvious next entries and are exactly why this is
 * an interface: they plug in without a caller changing.
 */
export const SPEECH_PROVIDERS = ['google', 'minimax', 'openrouter'] as const;

/** Derived from the tuple above, never written twice: a validator needs the
 *  runtime list (zod enums, a form's options) and the compiler needs the type,
 *  and two hand-kept copies drift the day a provider is added. */
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

/** Audio container/codec, as an IANA media type. Kept as a plain string union
 *  rather than a free-form string so a caller cannot ask for a format no
 *  provider has ever heard of and discover it at runtime. */
export type AudioMimeType =
  | 'audio/wav'
  /** Raw signed 16-bit little-endian mono samples, no header: the rate travels
   *  beside the bytes (`SpeechStreamChunk.sampleRate`), never inside. */
  | 'audio/pcm'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/webm'
  | 'audio/flac'
  | 'audio/mp4';

/** A voice a provider can speak with. `id` is what round-trips into an agent's
 *  configuration; everything else exists so a picker can be built without the
 *  UI knowing any vendor's naming. */
export interface Voice {
  id: string;
  label: string;
  /** BCP-47 tags this voice is documented to handle, empty when the vendor
   *  claims the voice is language-agnostic (Gemini's are). */
  languages: readonly string[];
  /** Free-text vendor description ("Firm", "Bright"), shown as a hint. */
  description?: string;
}

export interface SynthesizeRequest {
  text: string;
  /** A `Voice.id` from the same provider. Required, never defaulted: a silent
   *  fallback to "some voice" is how an agent ends up sounding like a different
   *  agent after an unrelated change. */
  voiceId: string;
  /** BCP-47 hint. Providers that infer language from the text ignore it. */
  language?: string;
  /**
   * Vendor model id, when the vendor has more than one worth choosing —
   * MiniMax ships a fast line and a high-fidelity line, and which one an agent
   * should use is a judgement about that agent, not a constant of the codebase.
   *
   * Optional, and each adapter documents its own default. Left out of the
   * `SPEECH_PROVIDERS`-style union on purpose: model names move at the vendors'
   * pace, and a build that cannot name a model released last week is worse than
   * one that passes an unknown string through and reports the vendor's refusal.
   */
  model?: string;
  /**
   * A sustained delivery style ("warm and friendly", "whispering"), NEVER read
   * aloud. Gemini TTS reads its input verbatim, so a direction written into
   * `text` is spoken; the style travels in a field of its own instead. Adapters
   * whose vendor has no such field document that they do not send it.
   */
  style?: string;
}

export interface SynthesizeResult {
  audio: Uint8Array;
  mimeType: AudioMimeType;
  /** Sample rate in Hz when the payload is raw or WAV-wrapped PCM. */
  sampleRate?: number;
  /** Wall-clock time the provider took. Carried on the RESULT, not logged
   *  somewhere central, because latency is this feature's product risk: a
   *  caller that wants to show or budget it should not have to measure it
   *  itself. First measurement, Gemini TTS, one short French sentence:
   *  3.7 s. That number is the reason the plan starts with push-to-talk
   *  rather than continuous conversation. */
  latencyMs: number;
}

export interface TranscribeRequest {
  audio: Uint8Array;
  /** What the bytes actually are. Providers reject what they don't accept —
   *  see `TranscriptionCapabilities.accepts` to pick before sending. */
  mimeType: AudioMimeType;
  /** BCP-47 hint; improves accuracy on short utterances for most vendors. */
  language?: string;
  /** Vendor model id; see `SynthesizeRequest.model`. */
  model?: string;
}

export interface TranscribeResult {
  text: string;
  latencyMs: number;
}

export interface SpeechCapabilities {
  /** What `synthesize` returns. A caller that must hand audio to a browser
   *  `<audio>` element, or to a channel that only takes one container, checks
   *  this instead of assuming. */
  outputs: readonly AudioMimeType[];
  /** Voices can be listed at runtime rather than being a fixed catalogue —
   *  true for vendors with user-cloned voices. */
  dynamicVoices: boolean;
  /**
   * The container `synthesizeStream` emits, present ONLY when the adapter
   * implements it. A caller reads this to set a response content type without
   * knowing the vendor, and its absence is how it learns to fall back to the
   * one-shot `synthesize`.
   *
   * This is the single most important capability in the file. Measured on
   * 2026-08-11: waiting for a whole reply costs 4.0 s before any sound; the
   * first bytes of the same reply arrive in 0.5 s. The perceived difference is
   * not "a bit quicker", it is the difference between a broken feature and a
   * conversation.
   */
  streamOutput?: AudioMimeType;
  /**
   * The vendor's synthesis models worth choosing between, most useful first.
   *
   * Declared here rather than typed into a picker: which models a vendor offers
   * is knowledge about that vendor, and a copy of it in the UI is the hardcoded
   * metadata invariant #1 forbids. Empty for vendors with a single line.
   */
  models?: readonly SpeechModel[];
}

/** One selectable synthesis model. `note` is what the user needs to choose —
 *  faster or richer — not a marketing line. */
export interface SpeechModel {
  id: string;
  label: string;
  note?: string;
}

export interface TranscriptionCapabilities {
  /** Media types the provider accepts as input. The browser's MediaRecorder
   *  produces `audio/webm` or `audio/ogg` depending on the engine, so a client
   *  intersects its own support with this list — and fails loud when the
   *  intersection is empty rather than sending bytes that will be rejected. */
  accepts: readonly AudioMimeType[];
}

/**
 * What a call needs to reach a vendor, handed in by the caller on every call.
 *
 * This package never reads a secret, an environment variable or the database:
 * the caller (the runner) resolves the key where keys live and passes it here.
 *
 * `fetch` is REQUIRED, never defaulted to the global one. Every provider call
 * of the process rides the dedicated HTTP/1.1 transport of packages/llm
 * (`providerFetch`, #608): on the global `fetch`, one unread body held every
 * other model call of the process behind it. A default here would quietly put
 * speech back on the shared connection.
 */
export interface SpeechConnection {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  /**
   * The vendor's API root, when the caller holds one configured with this key
   * (an OpenRouter key stored with a base URL). Absent, each adapter uses the
   * vendor's documented root. The caller passes it only when it IS that
   * vendor's root: MiniMax's stored base URL is its chat surface, not its
   * speech one (see providers/minimax.ts).
   */
  baseURL?: string;
}

/**
 * One piece of a streamed synthesis.
 *
 * The container and the sample rate travel WITH the bytes, not in the
 * capabilities: they belong to the answer, not to the vendor. Measured by the
 * orchestrator on 2026-11-03 through OpenRouter: most speech models answer
 * `audio/pcm;rate=24000;channels=1`, one answers pcm at 44 100 Hz, and MiniMax
 * answers mp3 only. A container or a rate declared once per adapter would play
 * those as noise, or at the wrong pitch (#969).
 */
export interface SpeechStreamChunk {
  audio: Uint8Array;
  /** The container of THIS answer. `capabilities.streamOutput` is only the usual one. */
  mimeType: AudioMimeType;
  /** Present for `audio/pcm`: raw samples do not say how fast they play. */
  sampleRate?: number;
}

/** Text → audio. */
export interface SpeechAdapter {
  readonly provider: SpeechProvider;
  readonly capabilities: SpeechCapabilities;
  /** The voices this provider can speak with. Static vendors return a constant
   *  list without touching the network; the connection is still required so a
   *  dynamic-voice vendor can be added later without changing the signature. */
  listVoices(connection: SpeechConnection): Promise<readonly Voice[]>;
  synthesize(req: SynthesizeRequest, connection: SpeechConnection): Promise<SynthesizeResult>;
  /**
   * Emit the audio as the vendor produces it, in `capabilities.streamOutput`.
   *
   * Optional, and the optionality is the point: a vendor that only returns a
   * finished file (Gemini TTS) genuinely cannot do this, and pretending
   * otherwise — by yielding the whole buffer as one chunk — would let a caller
   * believe it has a low time-to-first-sound when it does not. Callers branch
   * on `streamOutput` instead.
   *
   * Yields nothing before the first real audio byte, so the caller can measure
   * time-to-first-sound simply by timing the first iteration.
   */
  synthesizeStream?(
    req: SynthesizeRequest,
    connection: SpeechConnection,
  ): AsyncIterable<SpeechStreamChunk>;
  /**
   * The models the vendor serves for speech right now, each with its voices,
   * asked of the vendor itself (#969). Optional: a vendor with a single line
   * declares `capabilities.models` instead. Every call reaches the network:
   * how long a list may be kept is the caller's decision, not this package's.
   */
  listModels?(connection: SpeechConnection): Promise<readonly SpeechModelOffer[]>;
}

/**
 * A model the vendor says it serves NOW, with the voices it says that model
 * offers (#969). Read from the vendor at runtime (`listModels`), never typed
 * into the code: a list in the code describes the vendor as it was the day
 * someone wrote it. `voices` empty: the vendor names no voice for this model,
 * so none can be chosen.
 */
export interface SpeechModelOffer {
  id: string;
  label: string;
  voices: readonly Voice[];
}

/** Audio → text. */
export interface TranscriptionAdapter {
  readonly provider: SpeechProvider;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(req: TranscribeRequest, connection: SpeechConnection): Promise<TranscribeResult>;
  /** The models the vendor serves for transcription now, asked of the vendor (#976). */
  listModels?(connection: SpeechConnection): Promise<readonly TranscriptionModelOffer[]>;
}

/** A transcription model the vendor says it serves now (#976). */
export interface TranscriptionModelOffer {
  id: string;
  label: string;
}
