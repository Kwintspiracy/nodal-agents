import { describe, it, expect } from 'vitest';
import { pcmToWav, sampleRateFromMimeType } from '../wav.ts';
import { SpeechError } from '../errors.ts';

/**
 * A WAV header is 44 bytes and none of them fail loudly when wrong. A bad
 * sample rate does not crash — it plays the same samples at the wrong pitch and
 * speed, which gets blamed on the voice. A bad chunk size does not crash — it
 * truncates the tail, which gets blamed on the model. So every field is
 * asserted at its documented offset, against the spec rather than against
 * whatever the implementation happens to emit.
 */
const le32 = (b: Uint8Array, o: number): number => new DataView(b.buffer).getUint32(o, true);
const le16 = (b: Uint8Array, o: number): number => new DataView(b.buffer).getUint16(o, true);
const ascii = (b: Uint8Array, o: number, n: number): string =>
  String.fromCharCode(...b.slice(o, o + n));

describe('pcmToWav — the 44 bytes that make raw samples playable', () => {
  const pcm = new Uint8Array(1000).fill(7);

  it('lays out a canonical 16-bit mono header', () => {
    const wav = pcmToWav(pcm, { sampleRate: 24_000 });

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    // Everything after this field: 4 (WAVE) + 24 (fmt) + 8 (data header) = 36.
    expect(le32(wav, 4)).toBe(36 + pcm.length);
    expect(ascii(wav, 8, 4)).toBe('WAVE');

    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(le32(wav, 16)).toBe(16); // PCM fmt chunk length
    expect(le16(wav, 20)).toBe(1); // 1 = uncompressed PCM
    expect(le16(wav, 22)).toBe(1); // mono
    expect(le32(wav, 24)).toBe(24_000);
    expect(le32(wav, 28)).toBe(24_000 * 2); // byteRate = rate × blockAlign
    expect(le16(wav, 32)).toBe(2); // blockAlign = channels × bytesPerSample
    expect(le16(wav, 34)).toBe(16);

    expect(ascii(wav, 36, 4)).toBe('data');
    expect(le32(wav, 40)).toBe(pcm.length);
  });

  it('copies the samples through byte for byte, at offset 44', () => {
    const ramp = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    const wav = pcmToWav(ramp, { sampleRate: 24_000 });
    expect(wav.length).toBe(44 + ramp.length);
    expect([...wav.slice(44)]).toEqual([...ramp]);
  });

  it('carries the caller’s rate rather than a house default', () => {
    // The trap this closes: hardcoding 24000 because that is what Gemini
    // returns today. A 16 kHz provider would then play 1.5× too fast.
    expect(le32(pcmToWav(pcm, { sampleRate: 16_000 }), 24)).toBe(16_000);
    expect(le32(pcmToWav(pcm, { sampleRate: 48_000 }), 24)).toBe(48_000);
  });

  it('recomputes byteRate and blockAlign for stereo and for 8-bit', () => {
    const stereo = pcmToWav(pcm, { sampleRate: 44_100, channels: 2 });
    expect(le16(stereo, 22)).toBe(2);
    expect(le16(stereo, 32)).toBe(4); // 2 channels × 2 bytes
    expect(le32(stereo, 28)).toBe(44_100 * 4);

    const eightBit = pcmToWav(pcm, { sampleRate: 8_000, bitsPerSample: 8 });
    expect(le16(eightBit, 34)).toBe(8);
    expect(le16(eightBit, 32)).toBe(1);
    expect(le32(eightBit, 28)).toBe(8_000);
  });

  it('refuses an impossible rate instead of writing a header nobody can play', () => {
    expect(() => pcmToWav(pcm, { sampleRate: 0 })).toThrow(SpeechError);
    expect(() => pcmToWav(pcm, { sampleRate: -1 })).toThrow(/invalid sampleRate/);
    expect(() => pcmToWav(pcm, { sampleRate: 24_000, bitsPerSample: 12 })).toThrow(/multiple of 8/);
  });

  it('handles empty input without producing a header that claims data', () => {
    const wav = pcmToWav(new Uint8Array(0), { sampleRate: 24_000 });
    expect(wav.length).toBe(44);
    expect(le32(wav, 40)).toBe(0);
    expect(le32(wav, 4)).toBe(36);
  });
});

describe('sampleRateFromMimeType', () => {
  it('reads the rate Gemini actually sends', () => {
    expect(sampleRateFromMimeType('audio/L16;codec=pcm;rate=24000')).toBe(24_000);
  });

  it('tolerates spacing and a different parameter order', () => {
    expect(sampleRateFromMimeType('audio/L16; rate=16000; codec=pcm')).toBe(16_000);
  });

  it('throws rather than guessing when the rate is absent', () => {
    // The whole point: a default of 24000 here would be a silent smart
    // fallback (invariant #4), audible only as a wrong-pitch voice.
    expect(() => sampleRateFromMimeType('audio/L16;codec=pcm')).toThrow(/refusing to guess/);
    expect(() => sampleRateFromMimeType('audio/wav')).toThrow(SpeechError);
  });

  it('does not mistake another number for the rate', () => {
    expect(() => sampleRateFromMimeType('audio/L16;codec=pcm16;bitrate=384000')).toThrow(
      /refusing to guess/,
    );
  });
});
