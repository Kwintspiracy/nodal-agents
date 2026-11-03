// voice-speech.test.ts — la voix d'une réponse, phrase par phrase, dans l'ordre (#943).
//
// La frontière remplacée est la voix liée (`BoundSpeech`) : un faux qui
// répond quand le test le décide. Ce que les cas lisent est ce qui SORT — les
// morceaux, leur rang, leurs octets —, jamais un compte d'appels seul.
//
// Mutations vérifiées (chacune rougit au moins un cas ci-dessous) :
//   - le plafond de deux phrases en vol retiré (`inFlight` ignoré) → « two at
//     a time » ;
//   - `reset` qui ne retire pas les phrases en attente → « reset » ;
//   - l'échec d'une phrase sauté au lieu d'arrêter la voix → « a failure ».

import { describe, it, expect } from 'vitest';
import { SpeechError, type BoundSpeech, type SynthesizeRequest } from '@nodal-agents/speech';
import { createReplySpeech, type SpokenChunk } from '../../chat/voice-speech.ts';

/** Une voix dont chaque phrase attend que le test la libère. */
function heldVoice(streaming: boolean) {
  const pending = new Map<string, { release: () => void; fail: (err: Error) => void }>();
  const asked: string[] = [];
  const wait = (text: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      pending.set(text, { release: resolve, fail: reject });
    });
  const bytes = (text: string): Uint8Array => Uint8Array.from([text.length, 0]);
  const speech: BoundSpeech = {
    provider: 'openrouter',
    capabilities: streaming
      ? {
          outputs: ['audio/wav'],
          dynamicVoices: false,
          streamOutput: 'audio/pcm',
        }
      : { outputs: ['audio/wav'], dynamicVoices: false },
    listVoices: () => Promise.resolve([]),
    async synthesize(req: SynthesizeRequest) {
      asked.push(req.text);
      await wait(req.text);
      return { audio: bytes(req.text), mimeType: 'audio/wav', sampleRate: 24_000, latencyMs: 1 };
    },
    ...(streaming
      ? {
          async *synthesizeStream(req: SynthesizeRequest) {
            asked.push(req.text);
            yield {
              audio: Uint8Array.from([1, 0]),
              mimeType: 'audio/pcm' as const,
              sampleRate: 24_000,
            };
            await wait(req.text);
            yield { audio: bytes(req.text), mimeType: 'audio/pcm' as const, sampleRate: 24_000 };
          },
        }
      : {}),
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    speech,
    asked,
    async release(text: string) {
      await tick();
      pending.get(text)!.release();
      await tick();
    },
    async fail(text: string) {
      await tick();
      pending.get(text)!.fail(new SpeechError('speech_provider_error', `refused ${text}`));
      await tick();
    },
  };
}

/** What came out, in order: the chunks, and every sentence end with its outcome. */
function collector() {
  const chunks: SpokenChunk[] = [];
  const log: string[] = [];
  return {
    chunks,
    log,
    onChunk: (c: SpokenChunk) => {
      chunks.push(c);
      log.push(`audio ${String(c.sentence)}`);
    },
    onSentenceEnd: (sentence: number, complete: boolean) =>
      log.push(`end ${String(sentence)} ${complete ? 'complete' : 'cut'}`),
  };
}

describe('createReplySpeech @cap:parler-a-un-agent/moteur', () => {
  it('a voice that cannot stream: one file per sentence, in order, two at a time', async () => {
    const v = heldVoice(false);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('A.');
    voice.say('Bb.');
    voice.say('Ccc.');
    voice.end();
    await v.release('Bb.'); // the second is ready first
    // Two at a time: the third is not asked while the first is still out.
    expect(v.asked).toEqual(['A.', 'Bb.']);
    expect(out.chunks).toEqual([]);
    await v.release('A.');
    expect(v.asked).toEqual(['A.', 'Bb.', 'Ccc.']);
    await v.release('Ccc.');
    expect(await voice.done).toBeNull();
    expect(out.chunks).toEqual([
      {
        seq: 0,
        sentence: 0,
        mimeType: 'audio/wav',
        sampleRate: 24_000,
        audio: Uint8Array.from([2, 0]),
      },
      {
        seq: 1,
        sentence: 1,
        mimeType: 'audio/wav',
        sampleRate: 24_000,
        audio: Uint8Array.from([3, 0]),
      },
      {
        seq: 2,
        sentence: 2,
        mimeType: 'audio/wav',
        sampleRate: 24_000,
        audio: Uint8Array.from([4, 0]),
      },
    ]);
  });

  it('a voice that streams: its bytes pass as they arrive, in the declared format, sentence after sentence', async () => {
    const v = heldVoice(true);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('One.');
    voice.say('Two.');
    await v.release('Two.');
    // The first bytes of the FIRST sentence are out before it ends; the
    // second's, although finished, wait their turn.
    expect(out.chunks.map((c) => [...c.audio])).toEqual([[1, 0]]);
    await v.release('One.');
    voice.end();
    expect(await voice.done).toBeNull();
    expect(out.chunks.map((c) => [c.seq, c.mimeType, c.sampleRate, ...c.audio])).toEqual([
      [0, 'audio/pcm', 24_000, 1, 0],
      [1, 'audio/pcm', 24_000, 4, 0],
      [2, 'audio/pcm', 24_000, 1, 0],
      [3, 'audio/pcm', 24_000, 4, 0],
    ]);
  });

  it('a failure stops the voice there, says why, and nothing after it is heard', async () => {
    const v = heldVoice(false);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('A.');
    voice.say('Bb.');
    voice.say('Ccc.');
    voice.end();
    await v.release('A.');
    await v.fail('Bb.');
    expect(await voice.done).toEqual({ code: 'speech_provider_error', detail: 'refused Bb.' });
    expect(out.chunks.map((c) => [...c.audio])).toEqual([[2, 0]]);
  });

  it('reset drops what is not yet heard; the sentences said after it are heard', async () => {
    const v = heldVoice(false);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('Stale.');
    voice.reset();
    voice.say('Fresh one.');
    voice.end();
    await v.release('Stale.');
    await v.release('Fresh one.');
    expect(await voice.done).toBeNull();
    expect(out.chunks.map((c) => [c.seq, ...c.audio])).toEqual([[0, 10, 0]]);
  });

  it('cancel: silence at once, and no further sentence is asked', async () => {
    const v = heldVoice(false);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('A.');
    voice.say('Bb.');
    voice.say('Ccc.');
    voice.cancel();
    await v.release('A.');
    await v.release('Bb.');
    expect(await voice.done).toBeNull();
    expect(out.chunks).toEqual([]);
    expect(v.asked).toEqual(['A.', 'Bb.']);
  });

  // Review of #968, pass 2 (P2-B): EVERY sentence that emitted audio ends
  // once, with its outcome. Mutations verified: the end dropped on the error
  // path → "a vendor that fails mid-sentence"; dropped on reset → "reset ends".
  it('a vendor that fails mid-sentence: that sentence ends, cut, and nothing follows', async () => {
    const v = heldVoice(true);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('One.');
    voice.say('Two.');
    voice.end();
    await v.fail('One.');
    expect(await voice.done).toEqual({ code: 'speech_provider_error', detail: 'refused One.' });
    expect(out.log).toEqual(['audio 0', 'end 0 cut']);
  });

  it('reset ends the half-said sentence, cut, before the next one; a complete one ends complete', async () => {
    const v = heldVoice(true);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('Stale.');
    await new Promise((r) => setTimeout(r, 0));
    voice.reset();
    voice.say('Fresh one.');
    voice.end();
    await v.release('Fresh one.');
    expect(await voice.done).toBeNull();
    expect(out.log).toEqual(['audio 0', 'end 0 cut', 'audio 1', 'audio 1', 'end 1 complete']);
  });

  it('cancel ends the sentence that was being said, cut; a sentence that said nothing has no end', async () => {
    const v = heldVoice(true);
    const out = collector();
    const voice = createReplySpeech({
      speech: v.speech,
      model: 'google/gemini-3.8-flash-tts',
      voiceId: 'Kore',
      onChunk: out.onChunk,
      onSentenceEnd: out.onSentenceEnd,
    });
    voice.say('One.');
    voice.say('Two.');
    await new Promise((r) => setTimeout(r, 0));
    voice.cancel();
    expect(await voice.done).toBeNull();
    expect(out.log).toEqual(['audio 0', 'end 0 cut']);
  });
});
