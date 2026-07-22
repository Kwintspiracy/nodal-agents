// @nodal-agents/adapter-outlook-mail — body extraction helper tests

import { describe, it, expect } from 'vitest';
import { extractTextFromBody, capBody } from '../../helpers/body';

describe('extractTextFromBody', () => {
  it('returns plain text content unchanged when contentType is text', () => {
    expect(extractTextFromBody({ contentType: 'text', content: 'Hello world' })).toBe(
      'Hello world',
    );
  });

  it('strips HTML tags when contentType is html', () => {
    const result = extractTextFromBody({
      contentType: 'html',
      content: '<p>Hello <b>world</b></p>',
    });
    expect(result).toBe('Hello world');
  });

  it('strips <style> and <script> blocks entirely, not just their tags', () => {
    const html = '<style>.x{color:red}</style><script>alert(1)</script><p>Visible</p>';
    const result = extractTextFromBody({ contentType: 'html', content: html });
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('alert(1)');
    expect(result).toContain('Visible');
  });

  it('decodes common HTML entities', () => {
    const result = extractTextFromBody({
      contentType: 'html',
      content: '<p>Tom &amp; Jerry &lt;3&gt;</p>',
    });
    expect(result).toContain('Tom & Jerry <3>');
  });

  it('returns empty string for null/undefined body or missing content', () => {
    expect(extractTextFromBody(undefined)).toBe('');
    expect(extractTextFromBody(null)).toBe('');
    expect(extractTextFromBody({ contentType: 'text', content: undefined })).toBe('');
  });

  it('collapses 3+ consecutive blank lines to a double newline', () => {
    const result = extractTextFromBody({ contentType: 'html', content: 'para1\n\n\n\npara2' });
    expect(result).toBe('para1\n\npara2');
  });

  it('leaves a single blank line (2 newlines) between paragraphs untouched', () => {
    const result = extractTextFromBody({ contentType: 'html', content: 'para1\n\npara2' });
    expect(result).toBe('para1\n\npara2');
  });

  // review MINOR-1 regression guard: the original `/\n\s*\n\s*\n/g` had
  // quadratic backtracking on long ambiguous whitespace runs. This body is
  // ~35 000 chars of interleaved newlines/tabs/spaces designed to maximize
  // that ambiguity — with the linear `[ \t]*`-bounded regex plus the raw
  // 200 000-char pre-cap, this must still complete in well under a second.
  it('collapses blank-line runs quickly even on a large whitespace-heavy body (no catastrophic backtracking)', () => {
    const pathological = Array.from({ length: 5000 }, () => '\n \t ').join('') + 'end';
    const start = performance.now();
    const result = extractTextFromBody({ contentType: 'html', content: `<p>${pathological}</p>` });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toContain('end');
  });
});

describe('capBody', () => {
  it('returns the text untouched with truncated=false when under the cap', () => {
    const { body, truncated } = capBody('short text', 100);
    expect(body).toBe('short text');
    expect(truncated).toBe(false);
  });

  it('truncates and flags when over the cap — never silently', () => {
    const long = 'x'.repeat(200);
    const { body, truncated } = capBody(long, 100);
    expect(truncated).toBe(true);
    expect(body.startsWith('x'.repeat(100))).toBe(true);
    expect(body).toContain('[...body truncated]');
  });

  it('trims whitespace before measuring against the cap', () => {
    const { body, truncated } = capBody('   short   ', 100);
    expect(body).toBe('short');
    expect(truncated).toBe(false);
  });
});
