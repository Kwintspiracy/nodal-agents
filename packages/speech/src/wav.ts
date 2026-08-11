import { SpeechError } from './errors.ts';

/**
 * Wrap raw little-endian PCM in a WAV container.
 *
 * Needed because Gemini's TTS returns headerless samples
 * (`audio/L16;codec=pcm;rate=24000`), which no browser `<audio>` element and no
 * messaging channel will play. Forty-four bytes of header make the exact same
 * samples universally playable.
 *
 * Done here, in JavaScript, rather than by shelling out to ffmpeg: ffmpeg is
 * not installed on most machines that will run Nodal, and a feature that
 * silently needs a system binary is a feature that works on the developer's
 * machine and nowhere else. The probe that first proved this chain DID use
 * ffmpeg; that was a throwaway script, and keeping the dependency would have
 * shipped a Windows-and-my-laptop assumption into the product.
 */
export function pcmToWav(
  pcm: Uint8Array,
  opts: { sampleRate: number; channels?: number; bitsPerSample?: number },
): Uint8Array {
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  if (!Number.isInteger(opts.sampleRate) || opts.sampleRate <= 0) {
    throw new SpeechError('speech_bad_request', `pcmToWav: invalid sampleRate ${opts.sampleRate}`);
  }
  if (bitsPerSample % 8 !== 0) {
    throw new SpeechError(
      'speech_bad_request',
      `pcmToWav: bitsPerSample must be a multiple of 8, got ${bitsPerSample}`,
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = opts.sampleRate * blockAlign;

  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  // Everything after this field: 4 ("WAVE") + 24 (fmt chunk) + 8 (data header).
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk is 16 bytes
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, opts.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Read the sample rate out of a `audio/L16;codec=pcm;rate=24000` media type.
 *
 * The rate is NOT assumed: Gemini documents 24 kHz today, but a wrong rate does
 * not fail — it produces audio at the wrong pitch and speed, which is the kind
 * of bug that gets blamed on the voice rather than on the header. Absent or
 * unparseable, we say so instead of guessing.
 */
export function sampleRateFromMimeType(mimeType: string): number {
  const m = /(?:^|;)\s*rate=(\d+)/.exec(mimeType);
  if (!m?.[1]) {
    throw new SpeechError(
      'speech_provider_error',
      `no sample rate in audio media type "${mimeType}" — refusing to guess one, ` +
        'a wrong rate silently changes the pitch and speed of every reply',
    );
  }
  return Number.parseInt(m[1], 10);
}
