export type {
  AudioMimeType,
  SpeechAdapter,
  SpeechCapabilities,
  SpeechConnection,
  SpeechProvider,
  SpeechStreamChunk,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionAdapter,
  TranscriptionCapabilities,
  TranscriptionModelOffer,
  SpeechModel,
  SpeechModelOffer,
  Voice,
} from './speech-adapter.ts';

export { SPEECH_PROVIDERS } from './speech-adapter.ts';
export { SpeechError, vendorRefusalCode, type SpeechErrorCode } from './errors.ts';
export {
  getSpeechAdapter,
  getTranscriptionAdapter,
  speechProviders,
  transcriptionProviders,
} from './registry.ts';
export { pcmToWav, readWav, sampleRateFromMimeType, type WavInfo } from './wav.ts';
export {
  createSentenceChunker,
  splitSentences,
  SENTENCE_BOUNDS,
  type SentenceChunker,
  type SentenceChunkerOptions,
} from './sentence-chunker.ts';
export { isAudioChunk, languageBoostFor } from './providers/minimax.ts';
export { GEMINI_VOICES } from './providers/google.ts';
export {
  GEMINI_TTS_SAMPLE_RATE,
  openrouterSpeechAdapter,
  openrouterTranscriptionAdapter,
} from './providers/openrouter.ts';
export {
  bindSpeech,
  bindTranscription,
  type BoundSpeech,
  type BoundTranscription,
} from './bind.ts';
