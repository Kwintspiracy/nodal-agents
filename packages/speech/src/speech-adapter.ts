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

/** Text → audio. */
export interface SpeechAdapter {
  readonly provider: SpeechProvider;
  readonly capabilities: SpeechCapabilities;
  /** The voices this provider can speak with. Static vendors return a constant
   *  list without touching the network; `apiKey` is still required so a
   *  dynamic-voice vendor can be added later without changing the signature. */
  listVoices(apiKey: string): Promise<readonly Voice[]>;
  synthesize(req: SynthesizeRequest, apiKey: string): Promise<SynthesizeResult>;
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
  synthesizeStream?(req: SynthesizeRequest, apiKey: string): AsyncIterable<Uint8Array>;
}

/** Audio → text. */
export interface TranscriptionAdapter {
  readonly provider: SpeechProvider;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(req: TranscribeRequest, apiKey: string): Promise<TranscribeResult>;
}
