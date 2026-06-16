import { describe, it, expect } from 'vitest';
import { truncateForContext } from '../../job/execute.ts';

const b64 = (n: number) => 'A'.repeat(n); // [A-Za-z0-9+/] run → matches the binary regex

describe('truncateForContext', () => {
  it('leaves a small, non-binary result untouched', () => {
    expect(truncateForContext('hello world')).toBe('hello world');
  });

  it('elides a long base64/binary run (a generated image) to a tiny marker', () => {
    // Real case: comfyui__get_image returns ~50K of base64, re-sent every turn.
    const out = truncateForContext(JSON.stringify({ image: b64(50_000) }));
    expect(out).toContain('binary elided: 50000 chars');
    expect(out).not.toContain(b64(300)); // the raw blob is gone
    expect(out.length).toBeLessThan(2_000); // 50K → < 2K, no longer re-sent in bulk
    expect(out).not.toContain('[... truncated:'); // elided, not length-truncated
  });

  it('length-truncates a huge NON-binary text with the explicit marker', () => {
    const text = 'lorem ipsum dolor sit '.repeat(5_000); // ~110K, spaces ⇒ no base64 run
    const out = truncateForContext(text);
    expect(out.length).toBeLessThanOrEqual(50_000 + 120);
    expect(out).toContain('[... truncated:');
  });

  it('handles a result that is mostly base64 but also has real text', () => {
    const out = truncateForContext(`prompt: a cat\nresult: ${b64(40_000)}\ndone`);
    expect(out).toContain('prompt: a cat'); // useful text preserved
    expect(out).toContain('done');
    expect(out).toContain('binary elided: 40000 chars'); // blob stripped
  });
});
