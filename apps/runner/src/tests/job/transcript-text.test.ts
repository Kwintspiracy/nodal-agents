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
