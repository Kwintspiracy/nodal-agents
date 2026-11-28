// outbound.test.ts — the outbound seam is the single masker applied at the
// exit: the same output as the masker, the stream form equal to the whole text
// for any cutting, an already-masked value unchanged, the named exemptions
// only, and what it costs on a long reply.

import { describe, it, expect } from 'vitest';
import { fakeBearer, fakeSecret } from '@nodal-agents/test-kit';
import {
  createOutboundStream,
  OUTBOUND_EXEMPTIONS,
  outboundAsIs,
  outboundFields,
  outboundText,
  outboundValue,
  REDACTED_TEXT,
  redactSecrets,
  redactSecretsInText,
  type OutboundExemption,
} from '../index';

const KEY = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');
const REPLY = `I pushed with ${KEY}, then called the API with ${fakeBearer('Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1')}.`;

describe('the outbound seam @cap:parler-a-un-agent/moteur', () => {
  it('a text: the single masker, nothing else', () => {
    expect(outboundText(REPLY)).toBe(redactSecretsInText(REPLY));
    expect(outboundText(REPLY)).not.toContain(KEY);
    expect(outboundText(null)).toBeNull();
    expect(outboundText(undefined)).toBeUndefined();
    expect(outboundText('nothing to hide')).toBe('nothing to hide');
  });

  it('a structured value: names and shapes, the input untouched', () => {
    const value = { reply: REPLY, env: { DATABASE_URL: 'postgres://x' }, apiKey: 'plain', n: 3 };
    expect(outboundValue(value)).toEqual(redactSecrets(value));
    expect(value.reply).toBe(REPLY);
  });

  it('masking what is already masked changes nothing (a value masked before a cut, then at the exit)', () => {
    const once = outboundText(REPLY);
    expect(outboundText(once)).toBe(once);
    expect(outboundValue(outboundValue({ a: REPLY }))).toEqual(outboundValue({ a: REPLY }));
  });

  it('the stream form, cut anywhere, equals the whole text masked', () => {
    const whole = outboundText(REPLY);
    for (let cut = 0; cut <= REPLY.length; cut++) {
      const s = createOutboundStream();
      const out = s.push(REPLY.slice(0, cut)) + s.push(REPLY.slice(cut)) + s.flush();
      expect(out).toBe(whole);
    }
  });

  it('composes chunks already through the seam without masking them again', () => {
    const s = createOutboundStream();
    const chunk = s.push('plain words ');
    expect(chunk).toBe('plain words ');
    expect(outboundFields({ text: chunk, n: 1 })).toEqual({ text: 'plain words ', n: 1 });
  });

  it('an exemption leaves the value as it is, and only a named one exists', () => {
    expect(outboundAsIs(KEY, 'pairing-credential')).toBe(KEY);
    expect(Object.keys(OUTBOUND_EXEMPTIONS).sort()).toEqual([
      'encoded-bytes',
      'pairing-credential',
    ]);
    expect(() => outboundAsIs(KEY, 'because' as OutboundExemption)).toThrow(
      /outbound_exemption_unknown/,
    );
  });

  it('its cost on a long reply (100 kB of prose with keys in it), whole and streamed', () => {
    const paragraph = `The deploy went fine; the token was ${KEY} and the rest is ordinary prose. `;
    const reply = paragraph.repeat(Math.ceil(100_000 / paragraph.length));
    const t0 = performance.now();
    const whole = outboundText(reply);
    const t1 = performance.now();
    const s = createOutboundStream();
    let streamed = '';
    for (let i = 0; i < reply.length; i += 16) streamed += s.push(reply.slice(i, i + 16));
    streamed += s.flush();
    const t2 = performance.now();
    expect(streamed).toBe(whole);
    expect(whole).not.toContain(KEY);
    expect(whole).toContain(REDACTED_TEXT);
    // Stated in the PR; the bound only catches a change of order of magnitude.
    console.warn(
      `[outbound cost] ${reply.length} chars: whole ${(t1 - t0).toFixed(1)} ms, ` +
        `streamed in 16-char chunks ${(t2 - t1).toFixed(1)} ms`,
    );
    expect(t1 - t0).toBeLessThan(2_000);
  });
});
