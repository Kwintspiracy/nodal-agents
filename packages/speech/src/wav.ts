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

/** What a WAV container says about its samples. */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Length of the `data` chunk, in bytes: zero is a recording with no samples. */
  dataBytes: number;
  /** How long the samples play, rounded to the millisecond. */
  durationMs: number;
}

/**
 * Read a WAV container's header: its format and how long it plays (#941).
 *
 * Walks the chunks rather than reading fixed offsets: the 44-byte layout
 * `pcmToWav` writes is only the shortest one. Windows' recorder writes an
 * 18-byte `fmt ` chunk, other tools add `LIST` or `fact` chunks before `data`,
 * and a reader that assumed offset 40 would take metadata for samples. A
 * container that is not RIFF/WAVE PCM, or names no `data` chunk, is refused:
 * a duration guessed from the file size would be stored as a fact.
 */
export function readWav(bytes: Uint8Array): WavInfo {
  const ascii = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
    throw new SpeechError('speech_bad_request', 'readWav: not a RIFF/WAVE container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) {
        throw new SpeechError('speech_bad_request', 'readWav: truncated fmt chunk');
      }
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new SpeechError('speech_bad_request', 'readWav: data chunk before fmt');
      if (fmt.format !== 1) {
        throw new SpeechError(
          'speech_bad_request',
          `readWav: format ${fmt.format} is not uncompressed PCM`,
        );
      }
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      if (bytesPerSecond <= 0) {
        throw new SpeechError('speech_bad_request', 'readWav: the fmt chunk names no sample rate');
      }
      // A recorder that streamed its file may leave a size it did not know
      // yet: the samples are then what the file holds.
      const dataBytes = Math.min(size, bytes.length - body);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        dataBytes,
        durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
      };
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  throw new SpeechError('speech_bad_request', 'readWav: no data chunk');
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
