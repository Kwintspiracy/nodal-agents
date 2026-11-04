// transcription-check.test.ts — what counts as the probe written down, and the
// probe's audio as one file (#976).

import { describe, it, expect } from 'vitest';
import { readWav } from '@nodal-agents/speech';
import { heardTheProbe, probeAudio } from '../../chat/transcription-check.ts';

describe('the transcription check @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: `includes('ok')` replaced by an exact match on "ok" → red.
  it('"OK", "Okay." and "O.K." are the probe; an unrelated text and nothing are not', () => {
    for (const t of ['OK', 'Okay.', 'ok', ' O.K. ']) expect(heardTheProbe(t), t).toBe(true);
    for (const t of ['It is nine in the evening.', 'Quelle heure est-il ?', ''])
      expect(heardTheProbe(t), t).toBe(false);
  });

  it('PCM chunks become one WAV at their rate; a container is joined as it came; nothing is null', () => {
    const wav = probeAudio([
      { bytes: Uint8Array.from([1, 0, 2, 0]), mimeType: 'audio/pcm', sampleRate: 24_000 },
      { bytes: Uint8Array.from([3, 0]), mimeType: 'audio/pcm', sampleRate: 24_000 },
    ])!;
    expect(wav.mimeType).toBe('audio/wav');
    expect(readWav(wav.bytes).sampleRate).toBe(24_000);
    expect([...wav.bytes.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);

    expect(
      probeAudio([
        { bytes: Uint8Array.from([0xff, 0xfb]), mimeType: 'audio/mpeg' },
        { bytes: Uint8Array.from([0x90]), mimeType: 'audio/mpeg' },
      ]),
    ).toEqual({ bytes: Uint8Array.from([0xff, 0xfb, 0x90]), mimeType: 'audio/mpeg' });
    expect(probeAudio([])).toBeNull();
  });
});
