// audio-answer.ts — reading the audio a speech surface answered, for every
// adapter that speaks the OpenAI speech surface (`POST /audio/speech`):
// OpenRouter's, and any server the user runs (openai-compatible.ts, #1048).
// Moved here from openrouter.ts unchanged, so that both read an answer the
// same way: one mechanism, not two copies of it.

import { SpeechError } from '../errors.ts';
import type { AudioMimeType, SpeechStreamChunk } from '../speech-adapter.ts';

/**
 * The container of an answer, from its content type. No type at all is the
 * container that was ASKED for (`asked`: OpenRouter asks pcm, and the
 * odd-length check still catches a cut stream; a server the user runs is
 * asked wav); `audio/l16` is pcm under its RFC name.
 */
export function containerOf(contentType: string, asked: AudioMimeType): AudioMimeType | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type === '') return asked;
  switch (type) {
    case 'audio/pcm':
    case 'audio/l16':
      return 'audio/pcm';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'audio/mpeg';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'audio/wav';
    case 'audio/ogg':
    case 'audio/opus':
      return 'audio/ogg';
    case 'audio/flac':
      return 'audio/flac';
    case 'audio/aac':
    case 'audio/mp4':
      return 'audio/mp4';
    default:
      return null;
  }
}

/**
 * A compressed answer as it arrives: its bytes, untouched, with their media
 * type. A compressed frame cannot be cut anywhere, so the player joins a
 * sentence's chunks and decodes them once the sentence is complete (#968).
 */
export async function* streamCompressed(
  res: Response,
  model: string,
  container: AudioMimeType,
): AsyncGenerator<SpeechStreamChunk> {
  if (!res.body) {
    throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
  }
  const reader = res.body.getReader();
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      yield { audio: value, mimeType: container };
    }
  } finally {
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
  if (total === 0) {
    throw new SpeechError('speech_provider_error', `${model} answered 200 with no audio`);
  }
}
