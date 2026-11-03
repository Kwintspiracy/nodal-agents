// vendor-words-masked.test.ts — a vendor's error words never carry a credential
// into Nodal (review of #972, pass 2).
//
// The vendor's words are shown: under the turn's spoken failure, at Save, in
// the sample, to the agent of `generate_speech`, in the logs. A vendor can echo
// the key it refused. Every adapter's failure is a SpeechError, and a
// SpeechError's message is masked when it is built: these tests drive each
// vendor's refusal and read the message that comes out.

import { describe, it, expect } from 'vitest';
import { SpeechError } from '../errors.ts';
import { googleSpeechAdapter } from '../providers/google.ts';
import { minimaxSpeechAdapter } from '../providers/minimax.ts';
import { openrouterSpeechAdapter } from '../providers/openrouter.ts';
import type { SpeechConnection } from '../speech-adapter.ts';

const OR_KEY = `sk-or-v1-${'a1b2c3d4e5'.repeat(4)}`;
const GOOGLE_KEY = `AIza${'Sy0123456789abcdefghijKLMNOPQRS'.slice(0, 35)}`;

function answering(status: number, body: string): SpeechConnection {
  return { apiKey: 'k', fetch: async () => new Response(body, { status }) };
}

async function messageOf(p: Promise<unknown> | AsyncIterable<unknown>): Promise<string> {
  try {
    if (Symbol.asyncIterator in (p as object)) {
      for await (const _ of p as AsyncIterable<unknown>) {
        // drained
      }
    } else await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SpeechError);
    return (err as Error).message;
  }
  throw new Error('the refusal was not thrown');
}

describe('vendor words are masked where they enter Nodal @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: `super(message)` instead of `super(redactSecretsInText(message))`
  // in SpeechError → every case below is red.
  it('OpenRouter echoing an sk-or- key in a 401: masked, in the file path and the stream', async () => {
    const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${OR_KEY}` } });
    const req = { model: 'x-ai/grok-voice-tts-1.0', text: 'x', voiceId: 'leo' };
    for (const m of [
      await messageOf(openrouterSpeechAdapter.synthesize(req, answering(401, body))),
      await messageOf(openrouterSpeechAdapter.synthesizeStream!(req, answering(401, body))),
    ]) {
      expect(m).not.toContain(OR_KEY);
      expect(m).toBe(
        'openrouter x-ai/grok-voice-tts-1.0: HTTP 401 — Incorrect API key provided: [secret masqué] (sk-)',
      );
    }
  });

  it('Google echoing an AIza key: masked, in the file path, the stream and the models list', async () => {
    const body = JSON.stringify([{ error: { message: `API key not valid: ${GOOGLE_KEY}` } }]);
    const req = { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' };
    const plain = JSON.stringify({ error: { message: `API key not valid: ${GOOGLE_KEY}` } });
    for (const m of [
      await messageOf(googleSpeechAdapter.synthesize(req, answering(400, plain))),
      await messageOf(googleSpeechAdapter.synthesizeStream!(req, answering(400, body))),
      await messageOf(googleSpeechAdapter.listModels!(answering(400, plain))),
    ]) {
      expect(m).not.toContain(GOOGLE_KEY);
      expect(m).toContain('API key not valid: [secret masqué] (AIza)');
    }
  });

  it('MiniMax echoing a key: masked', async () => {
    const m = await messageOf(
      minimaxSpeechAdapter.synthesize(
        { text: 'x', voiceId: 'French_CasualMan' },
        answering(401, `invalid key ${OR_KEY}`),
      ),
    );
    expect(m).not.toContain(OR_KEY);
    expect(m).toContain('[secret masqué] (sk-)');
  });
});
