// chat/transcription-check.ts — a transcription model is stored only once it has
// written down what Nodal's own voice said, through the turn's path (#976).
//
// The rule #972 applies to voices, applied to the ear. Being listed by
// OpenRouter is not enough: a model can fail on the audio Nodal sends, or
// answer instead of transcribing. So before a model is written, the
// workspace's voice says the probe of #972 ("OK.", never played, never
// stored), and the candidate model transcribes that audio. It passes if the
// call succeeds and the normalised words contain "ok" ("OK", "Okay." both do).
//
// No audio ships with Nodal: the sample is spoken by the workspace's own voice,
// so no recording, and no one's voice, goes into the package. A voice that
// cannot speak blocks the check (`transcription_needs_voice`, with the voice's
// own words): a model is never accepted untested.
//
// Language coverage is NOT judged here. Whether a model handles French
// depends on what the person will speak, unknown at save time; a French check
// would refuse a model for someone who speaks English. The measured limit is
// stated in the PR instead: `deepgram/nova-3` returned empty text for French
// without a `language` (2026-11-03).

import { SpeechError, pcmToWav, type AudioMimeType } from '@nodal-agents/speech';
import type { WorkspaceEar } from '../job/resolve-voice.ts';

/** The probe's audio, as one file the transcription endpoint takes. */
export interface ProbeAudio {
  bytes: Uint8Array;
  mimeType: AudioMimeType;
}

/**
 * The probe's chunks as one file: PCM samples are joined and wrapped in a WAV
 * at their rate; a container (a WAV per sentence, mp3) is joined as it came.
 * `null`: the voice produced no audio.
 */
export function probeAudio(
  chunks: ReadonlyArray<{ bytes: Uint8Array; mimeType: string; sampleRate?: number }>,
): ProbeAudio | null {
  if (chunks.length === 0) return null;
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.bytes.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c.bytes, at);
    at += c.bytes.byteLength;
  }
  const first = chunks[0]!;
  if (first.mimeType === 'audio/pcm') {
    if (first.sampleRate === undefined) return null;
    return {
      bytes: pcmToWav(joined, { sampleRate: first.sampleRate }),
      mimeType: 'audio/wav',
    };
  }
  return { bytes: joined, mimeType: first.mimeType as AudioMimeType };
}

/** Lowercase letters and digits only. */
function normalised(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Did the model write the probe down? "OK", "Okay.", "O.K." all count. */
export function heardTheProbe(text: string): boolean {
  return normalised(text).includes('ok');
}

export interface EarRefusal {
  error: string;
  source: 'openrouter';
  detail: string;
}

/** Does the candidate ear write down what the voice said? `null`: yes. */
export async function earProbeRefusal(
  ear: WorkspaceEar,
  audio: ProbeAudio,
): Promise<EarRefusal | null> {
  let heard: string;
  try {
    ({ text: heard } = await ear.transcription.transcribe({
      audio: audio.bytes,
      mimeType: audio.mimeType,
      model: ear.model,
    }));
  } catch (err) {
    if (err instanceof SpeechError && err.code === 'speech_nothing_heard') {
      return {
        error: 'transcription_not_faithful',
        source: 'openrouter',
        detail: `${ear.model} wrote nothing for the voice saying "OK."`,
      };
    }
    return {
      error: err instanceof SpeechError ? err.code : 'transcription_failed',
      source: 'openrouter',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!heardTheProbe(heard)) {
    return {
      error: 'transcription_not_faithful',
      source: 'openrouter',
      detail: `${ear.model} wrote "${heard.slice(0, 160)}" for the voice saying "OK."`,
    };
  }
  return null;
}
