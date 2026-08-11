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
  Voice,
} from './speech-adapter.ts';

export { SpeechError, type SpeechErrorCode } from './errors.ts';
export {
  getSpeechAdapter,
  getTranscriptionAdapter,
  speechProviders,
  transcriptionProviders,
} from './registry.ts';
export { pcmToWav, sampleRateFromMimeType } from './wav.ts';
