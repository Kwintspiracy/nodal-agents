export type {
  AudioMimeType,
  SpeechAdapter,
  SpeechCapabilities,
  SpeechConnection,
  SpeechProvider,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
  SpeechModel,
  Voice,
} from './speech-adapter.ts';

export { SPEECH_PROVIDERS } from './speech-adapter.ts';
export { SpeechError, type SpeechErrorCode } from './errors.ts';
export {
  getSpeechAdapter,
  getTranscriptionAdapter,
  speechProviders,
  transcriptionProviders,
} from './registry.ts';
export { pcmToWav, sampleRateFromMimeType } from './wav.ts';
export { isAudioChunk, languageBoostFor } from './providers/minimax.ts';
export { GEMINI_VOICES } from './providers/google.ts';
export {
  DEFAULT_GEMINI_VOICE,
  GEMINI_TTS_SAMPLE_RATE,
  OPENROUTER_SPEECH_MODELS,
  openrouterSpeechAdapter,
  openrouterTranscriptionAdapter,
  type OpenRouterSpeechModelId,
} from './providers/openrouter.ts';
export {
  bindSpeech,
  bindTranscription,
  type BoundSpeech,
  type BoundTranscription,
} from './bind.ts';
