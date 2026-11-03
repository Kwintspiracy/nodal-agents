// mic-capture.test.ts — ce que le micro envoie est le `audio/pcm` du protocole
// (#942) : 16 bits signés little-endian, à 16 kHz, et la coupe en morceaux ne
// perd ni ne déplace un échantillon.

import { describe, it, expect } from 'vitest';
import { createDownsampler, floatToPcm16 } from '../mic-capture.ts';

describe('mic capture: the PCM the voice turn receives (#942) @cap:parler-a-un-agent/ecran', () => {
  it('floats become 16-bit signed little-endian samples, clamped', () => {
    const bytes = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -3]));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true))).toEqual([
      0, 32767, -32768, 16383, 32767, -32768,
    ]);
    // Little-endian : l'octet faible d'abord.
    expect([...bytes.slice(2, 4)]).toEqual([0xff, 0x7f]);
  });

  it('48 kHz to 16 kHz in chunks gives exactly what one block gives', () => {
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7));
    const whole = createDownsampler(48_000, 16_000)(input);
    const piecewise = createDownsampler(48_000, 16_000);
    const parts: number[] = [];
    // Des coupes qui ne tombent PAS sur un multiple de trois.
    for (const [a, b] of [
      [0, 128],
      [128, 1000],
      [1000, 1001],
      [1001, 4800],
    ] as const) {
      parts.push(...piecewise(input.subarray(a, b)));
    }
    expect(parts).toHaveLength(1600);
    expect(parts).toEqual([...whole]);
  });

  it('44.1 kHz keeps the duration: one second in chunks is 16 000 samples, give or take one per chunk', () => {
    const down = createDownsampler(44_100, 16_000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += down(new Float32Array(4410).fill(0.25)).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(10);
  });

  it('the average keeps a steady level', () => {
    const out = createDownsampler(48_000, 16_000)(new Float32Array(300).fill(0.5));
    expect(new Set(out)).toEqual(new Set([0.5]));
  });
});
