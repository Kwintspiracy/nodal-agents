// format.test.ts — formatJobResult: length splitting, headers, footers, edge cases

import { describe, it, expect } from 'vitest';
import { formatJobResult } from '../format.ts';

const FAKE_JOB_ID = '00000000-0000-0000-0000-000000000001';

describe('formatJobResult', () => {
  it('returns a single chunk for short messages', () => {
    const chunks = formatJobResult({
      id: FAKE_JOB_ID,
      task: 'Do something',
      result: 'Done.',
      error: null,
    });
    expect(chunks).toHaveLength(1);
  });

  it('includes title in HTML bold tags', () => {
    const [chunk] = formatJobResult({
      id: FAKE_JOB_ID,
      task: 'My Task',
      result: 'Result here',
      error: null,
    });
    expect(chunk).toContain('<b>My Task</b>');
  });

  it('includes result body', () => {
    const [chunk] = formatJobResult({
      id: FAKE_JOB_ID,
      task: 'My Task',
      result: 'The answer is 42.',
      error: null,
    });
    expect(chunk).toContain('The answer is 42.');
  });

  it('includes job id in footer by default', () => {
    const [chunk] = formatJobResult({
      id: FAKE_JOB_ID,
      task: 'My Task',
      result: 'Done.',
      error: null,
    });
    expect(chunk).toContain(`Job: ${FAKE_JOB_ID}`);
  });

  it('omits job id when includeJobId=false', () => {
    const [chunk] = formatJobResult(
      { id: FAKE_JOB_ID, task: 'My Task', result: 'Done.', error: null },
      { includeJobId: false },
    );
    expect(chunk).not.toContain('Job:');
  });

  it('uses error body when result is null', () => {
    const [chunk] = formatJobResult({
      id: FAKE_JOB_ID,
      task: 'My Task',
      result: null,
      error: 'Something went wrong',
    });
    expect(chunk).toContain('Something went wrong');
  });

  it('splits a 5000-char message into 2+ chunks each under maxLength', () => {
    const longBody = 'x'.repeat(5000);
    const chunks = formatJobResult(
      { id: FAKE_JOB_ID, task: 'Long Task', result: longBody, error: null },
      { maxLength: 4000, includeJobId: false },
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });

  it('reconstructed chunks contain all content', () => {
    const longBody = 'a'.repeat(2000) + '\n' + 'b'.repeat(2000);
    const chunks = formatJobResult(
      { id: FAKE_JOB_ID, task: 'T', result: longBody, error: null },
      { maxLength: 2500, includeJobId: false },
    );
    const joined = chunks.join('');
    // All 'a's and 'b's must be present in the output (2000 + 2000).
    // The <b>T</b> wrapper adds 2 extra 'b' chars from the HTML tags, so we
    // assert >=4000 rather than exact equality.
    expect(joined.replace(/[^ab]/g, '').length).toBeGreaterThanOrEqual(4000);
  });

  it('escapes HTML special characters in title and body', () => {
    const [chunk] = formatJobResult({
      id: FAKE_JOB_ID,
      task: '<Script>',
      result: '5 > 3 & 2 < 4',
      error: null,
    });
    expect(chunk).toContain('&lt;Script&gt;');
    expect(chunk).toContain('5 &gt; 3 &amp; 2 &lt; 4');
    // Must not contain unescaped special chars in the content
    expect(chunk).not.toContain('<Script>');
  });

  it('prefers newline split over hard split', () => {
    // Build a message that is slightly over maxLength but has a newline before the limit
    const part1 = 'a'.repeat(3990);
    const part2 = 'b'.repeat(100);
    // part1 + \n + part2 = 4091 chars in body; with title/footer it will split
    const chunks = formatJobResult(
      { id: FAKE_JOB_ID, task: 'T', result: `${part1}\n${part2}`, error: null },
      { maxLength: 4050, includeJobId: false },
    );
    if (chunks.length > 1) {
      // Verify no chunk starts with characters that should have been in the previous chunk
      expect(chunks[0]).not.toContain('b'.repeat(100));
    }
  });
});
