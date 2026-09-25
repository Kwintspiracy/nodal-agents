// speech-models.ts — the models that turn text into an audio file (#487).
//
// Kept apart from MODEL_CATALOG on purpose: these models speak, they do not
// chat or call tools. An agent set on one would fail on its first turn, so
// they are never offered as an agent's model, only to the `generate_speech`
// tool.
//
// Read off OpenRouter on 2026-09-25
// (`GET /api/v1/models/<id>/endpoints`): both answered
// `"modality": "text->speech"`, created 2026-09-23, context 8192 tokens,
// provider Google AI Studio.

export interface SpeechModel {
  /** OpenRouter model id, sent as `model` to `POST /api/v1/audio/speech`. */
  id: string;
  label: string;
  /** One line for the agent choosing between them. */
  summary: string;
  /** USD per million input tokens, as OpenRouter lists it. */
  inputPerMTok: number;
  /** USD per million output tokens, as OpenRouter lists it. */
  outputPerMTok: number;
}

export const SPEECH_MODELS = [
  {
    id: 'google/gemini-3.8-flash-tts',
    label: 'Gemini 3.8 Flash TTS',
    summary: 'The expressive tier: best for narration and a delivery style.',
    inputPerMTok: 0.5,
    outputPerMTok: 9,
  },
  {
    id: 'google/gemini-3.8-flash-lite-tts',
    label: 'Gemini 3.8 Flash Lite TTS',
    summary: 'The fast, cheaper tier: best for plain reading and volume.',
    inputPerMTok: 0.5,
    outputPerMTok: 6,
  },
] as const satisfies readonly SpeechModel[];

export type SpeechModelId = (typeof SPEECH_MODELS)[number]['id'];

export const SPEECH_MODEL_IDS = SPEECH_MODELS.map((m) => m.id) as [
  SpeechModelId,
  ...SpeechModelId[],
];

/** The voice the provider documents in its own example (OpenRouter's Gemini TTS section). */
export const DEFAULT_SPEECH_VOICE = 'Kore';
