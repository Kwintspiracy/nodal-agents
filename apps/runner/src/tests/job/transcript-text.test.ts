// transcript-text.test.ts — flattenTranscript: turn a job transcript into the
// plain-text blob that feeds the episodic full-text index (Brick 2).

import { describe, it, expect } from 'vitest';
import { flattenTranscript } from '../../job/transcript-text.ts';

describe('flattenTranscript', () => {
  it('extracts plain string message content', () => {
    const msgs = [{ role: 'user', content: 'génère une image z_image' }];
    expect(flattenTranscript(msgs)).toContain('z_image');
  });

  it('extracts text parts from multimodal array content and skips image bytes', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this picture' },
          { type: 'image', image: 'AAAABBBBbase64dataAAAA' },
        ],
      },
    ];
    const out = flattenTranscript(msgs);
    expect(out).toContain('describe this picture');
    expect(out).not.toContain('AAAA'); // image bytes are not indexed
  });

  it('extracts tool output text (nested)', () => {
    const msgs = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'web_search',
            output: { type: 'text', value: 'Paris is the capital of France' },
          },
        ],
      },
    ];
    expect(flattenTranscript(msgs)).toContain('Paris is the capital');
  });

  it('appends the final result', () => {
    expect(flattenTranscript([], 'the answer is forty-two')).toContain('forty-two');
  });

  it('drops structural noise (role/type) — no-text message flattens to empty', () => {
    const msgs = [{ role: 'user', content: [{ type: 'image', image: 'xxxx' }] }];
    expect(flattenTranscript(msgs)).toBe('');
  });

  it('never throws on malformed input', () => {
    expect(() => flattenTranscript(null)).not.toThrow();
    expect(flattenTranscript(undefined)).toBe('');
    expect(flattenTranscript('not an array' as unknown)).toContain('not an array');
  });

  it('collapses whitespace and bounds the output', () => {
    const huge = 'x'.repeat(200_000);
    const out = flattenTranscript([{ role: 'user', content: huge }]);
    expect(out.length).toBeLessThanOrEqual(60_000);
  });
});

describe('toDbSafeString / deepDbSafe (byte-level DB safety, 2026-07-17 incident)', () => {
  it('strips raw NUL bytes and repairs lone surrogates', async () => {
    const { toDbSafeString } = await import('../../job/transcript-text.ts');
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd83d); // high surrogate without pair
    expect(toDbSafeString(`a${nul}b`)).toBe('ab');
    expect(toDbSafeString(`x${loneSurrogate}y`)).toBe('x�y');
    expect(toDbSafeString('émoji 👍 café')).toBe('émoji 👍 café'); // well-formed untouched
  });

  it('deepDbSafe sanitizes every nested string without altering structure', async () => {
    const { deepDbSafe } = await import('../../job/transcript-text.ts');
    const nul = String.fromCharCode(0);
    const input = [
      { role: 'assistant', content: [{ type: 'text', text: `hello${nul}world` }], n: 42 },
    ];
    const out = deepDbSafe(input);
    expect(out[0]!.content[0]!.text).toBe('helloworld');
    expect(out[0]!.n).toBe(42);
    expect(out[0]!.role).toBe('assistant');
    // input non muté
    expect(input[0]!.content[0]!.text).toContain(nul);
  });

  it('flattenTranscript output is always DB-safe', () => {
    const nul = String.fromCharCode(0);
    const out = flattenTranscript([{ role: 'user', content: `find${nul}this` }]);
    expect(out).toBe('findthis');
    expect(out.includes(nul)).toBe(false);
  });
});
