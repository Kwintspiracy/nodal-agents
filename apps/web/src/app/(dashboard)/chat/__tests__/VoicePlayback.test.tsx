// VoicePlayback.test.tsx — la voix d'une réponse, jouée bout à bout (#943).
//
// La voix arrive en morceaux numérotés ; la page les programme sur UN
// AudioContext, chacun à l'instant où le précédent finit. Le contexte est un
// faux (`fake-audio.ts`) qui note ce qui aurait été entendu, et quand : les
// assertions portent sur ces instants et ces échantillons.
//
// Mutations vérifiées (chacune rougit au moins un cas) :
//   - chaque morceau programmé à `currentTime + LEAD_S` au lieu de la fin du
//     précédent → « back to back » (les morceaux se chevauchent) ;
//   - la file de décodage retirée (chaque morceau programmé dès qu'il est
//     décodé) → « a WAV chunk decoded slower » (le PCM suivant passe devant) ;
//   - `stopSpeaking` qui ne coupe pas les sources → « Stop ».

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { startSpokenStream, stopSpeaking, useSpeaking } from '../voice-playback.ts';
import { installFakeAudio } from './fake-audio.ts';

let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  audio = installFakeAudio(vi.stubGlobal);
});

afterEach(() => {
  stopSpeaking();
  vi.unstubAllGlobals();
});

const pcm = (samples: number[]): Uint8Array => {
  const b = new Uint8Array(samples.length * 2);
  const v = new DataView(b.buffer);
  samples.forEach((s, i) => v.setInt16(i * 2, s, true));
  return b;
};

/** The fake MP3 frame `fake-audio.ts` decodes: `ID3`, a length, the bytes. */
const mp3 = (bytes: number[]): Uint8Array =>
  Uint8Array.from([0x49, 0x44, 0x33, bytes.length, ...bytes]);

function wav(samples: number[], rate: number): Uint8Array {
  const data = pcm(samples);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x52494646, false);
  v.setUint32(24, rate, true);
  out.set(data, 44);
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the spoken reply plays its chunks in order, back to back (#943) @cap:parler-a-un-agent/ecran', () => {
  it('back to back: each chunk starts exactly where the previous one ends', async () => {
    const voice = startSpokenStream({ reply: 'Hi.', onError: () => {} });
    audio.currentTime = 1;
    // 0.5 s, 0.25 s and 0.5 s at 4 Hz: easy to read.
    voice.push({ seq: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([16384, 0]) });
    voice.push({ seq: 1, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([-16384]) });
    voice.push({ seq: 2, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([8192, 8192]) });
    await flush();
    expect(audio.scheduled.map((s) => [s.at, s.duration, s.samples])).toEqual([
      [1.03, 0.5, [0.5, 0]],
      [1.53, 0.25, [-0.5]],
      [1.78, 0.5, [0.25, 0.25]],
    ]);
  });

  it('a WAV chunk decoded slower than the PCM after it still plays first', async () => {
    const voice = startSpokenStream({ reply: 'Hi.', onError: () => {} });
    voice.push({ seq: 0, mimeType: 'audio/wav', bytes: wav([16384, 16384], 4) });
    voice.push({ seq: 1, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([-16384]) });
    await flush();
    await flush();
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, 0.5], [-0.5]]);
    expect(audio.scheduled[1]!.at).toBeCloseTo(audio.scheduled[0]!.at + 0.5, 6);
  });

  it('"Speaking" lasts from the first sound to the end of the last chunk, once the stream ended', async () => {
    const seen: Array<string | null> = [];
    function Probe() {
      const s = useSpeaking();
      seen.push(s?.reply ?? null);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    const voice = startSpokenStream({ reply: 'One.', onError: () => {} });
    await act(async () => {
      voice.push({ seq: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([1]) });
      await flush();
    });
    await act(async () => {
      voice.setReply('One. Two.');
      voice.push({ seq: 1, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([2]) });
      await flush();
    });
    await act(async () => {
      audio.scheduled[0]!.finish();
      audio.scheduled[1]!.finish();
    });
    // Both chunks played, but more may come: still speaking.
    expect(seen.at(-1)).toBe('One. Two.');
    await act(async () => {
      voice.end();
      await flush();
    });
    expect(seen.filter((v, i) => v !== seen[i - 1])).toEqual([null, 'One.', 'One. Two.', null]);
    await act(async () => {
      root.unmount();
    });
  });

  it('Stop: every scheduled chunk is cut, and what arrives after is not played', async () => {
    const voice = startSpokenStream({ reply: 'Hi.', onError: () => {} });
    voice.push({ seq: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([1]) });
    voice.push({ seq: 1, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([2]) });
    await flush();
    stopSpeaking();
    expect(audio.scheduled.map((s) => s.stopped)).toEqual([true, true]);
    expect(voice.stopped).toBe(true);
    voice.push({ seq: 2, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([3]) });
    await flush();
    expect(audio.scheduled).toHaveLength(2);
  });

  // Review of #968, pass 1 (P2-2). Mutations verified: the pcm/wav-only gate
  // restored → red; a compressed chunk decoded on its own instead of per
  // sentence → red (a cut frame does not decode).
  it('a compressed voice (MP3) plays per sentence, its chunks joined, in order, back to back', async () => {
    const errors: string[] = [];
    const voice = startSpokenStream({ reply: 'Hi.', onError: (m) => errors.push(m) });
    // Sentence 0: one MP3 frame cut across two network chunks.
    voice.push({ seq: 0, mimeType: 'audio/mpeg', bytes: mp3([128, 64, 32, 16]).slice(0, 5) });
    voice.push({ seq: 1, mimeType: 'audio/mpeg', bytes: mp3([128, 64, 32, 16]).slice(5) });
    await flush();
    // Nothing plays before the sentence is complete: half a frame is not sound.
    expect(audio.scheduled).toEqual([]);
    voice.endSentence();
    // Sentence 1, a frame of its own; the stream ends.
    voice.push({ seq: 2, mimeType: 'audio/mpeg', bytes: mp3([8, 4]) });
    voice.end();
    await flush();
    await flush();
    expect(errors).toEqual([]);
    expect(audio.scheduled.map((s) => s.samples)).toEqual([
      [0.5, 0.25, 0.125, 0.063],
      [0.031, 0.016],
    ]);
    expect(audio.scheduled[1]!.at).toBeCloseTo(audio.scheduled[0]!.at + 4 / 8000, 9);
  });

  it('a missing rank, or a voice the browser cannot decode, is said, and the voice stops', async () => {
    const errors: string[] = [];
    const gap = startSpokenStream({ reply: 'Hi.', onError: (m) => errors.push(m) });
    gap.push({ seq: 1, mimeType: 'audio/pcm', sampleRate: 4, bytes: pcm([1]) });
    expect(gap.stopped).toBe(true);
    const unknown = startSpokenStream({ reply: 'Hi.', onError: (m) => errors.push(m) });
    unknown.push({ seq: 0, mimeType: 'audio/x-unknown', bytes: new Uint8Array([1, 2, 3]) });
    unknown.end();
    await flush();
    expect(unknown.stopped).toBe(true);
    expect(errors).toEqual([
      'voice chunk 1 arrived where 0 was expected',
      'this voice could not be decoded (audio/x-unknown): Unable to decode audio data',
    ]);
    expect(audio.scheduled).toEqual([]);
  });
});
