export type {
  AudioMimeType,
  SpeechAdapter,
  SpeechCapabilities,
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
