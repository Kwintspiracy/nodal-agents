// read-lines.test.ts — parity contract between readLinesWindowed() and
// `content.split('\n')`, including the multi-byte UTF-8 chunk-boundary case.
// Uses a small `chunkBytes` override so boundary-straddling scenarios are
// deterministic without needing multi-hundred-KB fixture files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLinesWindowed, ReadLinesCapExceededError } from './read-lines';

let DIR: string;

beforeEach(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'nodal-readlines-'));
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

async function writeFixture(content: string): Promise<string> {
  const p = join(DIR, 'fixture.txt');
  await writeFile(p, content, 'utf8');
  return p;
}

describe("readLinesWindowed — parity with content.split('\\n')", () => {
  it('matches on an empty file: exactly one empty line', async () => {
    const p = await writeFixture('');
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, 10);
    expect(totalLines).toBe(''.split('\n').length);
    expect(totalLines).toBe(1);
    expect(windowLines).toEqual(['']);
  });

  it('a trailing newline produces an extra empty final line, counted in total_lines', async () => {
    const content = 'a\nb\nc\n';
    const p = await writeFixture(content);
    const reference = content.split('\n'); // ['a','b','c','']
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
  });

  it('no trailing newline: last line has no extra empty entry', async () => {
    const content = 'a\nb\nc';
    const p = await writeFixture(content);
    const reference = content.split('\n'); // ['a','b','c']
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
  });

  it('preserves trailing \\r on CRLF line endings (no CRLF stripping)', async () => {
    const content = 'a\r\nb\r\nc\r\n';
    const p = await writeFixture(content);
    const reference = content.split('\n'); // ['a\r','b\r','c\r','']
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
    expect(windowLines[0]).toBe('a\r');
  });

  it('windows to an exact [startIdx, endIdxCeiling) slice matching Array.slice', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const content = lines.join('\n');
    const p = await writeFixture(content);
    const reference = content.split('\n');
    const { windowLines, totalLines } = await readLinesWindowed(p, 10, 20);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference.slice(10, 20));
  });

  it('a multi-byte UTF-8 character split exactly across a chunk boundary decodes intact (é)', async () => {
    // Force the 2-byte UTF-8 encoding of 'é' (0xC3 0xA9) to straddle a tiny
    // chunk boundary: 'a'.repeat(9) is 9 bytes, so with chunkBytes=10 the
    // boundary falls at byte 10 — right after the first byte of 'é'.
    const content = 'a'.repeat(9) + 'é' + 'bcd\nsecond line';
    const p = await writeFixture(content);
    const reference = content.split('\n');
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length, 10);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
    expect(windowLines[0]).toContain('é');
  });

  it('a multi-byte UTF-8 character split exactly across a chunk boundary decodes intact (你, 3 bytes)', async () => {
    // '你' encodes to 3 bytes (0xE4 0xBD 0xA0). With chunkBytes=8 and 7 leading
    // ASCII bytes, the boundary falls after the first byte of '你', splitting
    // it 1 byte / 2 bytes across two chunks.
    const content = 'a'.repeat(7) + '你' + 'zzz\nline2\nline3';
    const p = await writeFixture(content);
    const reference = content.split('\n');
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length, 8);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
    expect(windowLines[0]).toContain('你');
  });

  it('a line itself straddling a chunk boundary is reassembled whole', async () => {
    // chunkBytes=5 forces many chunk splits across a longer line.
    const content = 'abcdefghijklmnopqrstuvwxyz\nshort';
    const p = await writeFixture(content);
    const reference = content.split('\n');
    const { windowLines, totalLines } = await readLinesWindowed(p, 0, reference.length, 5);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual(reference);
  });

  it('startIdx beyond total lines yields an empty window (matches Array.slice semantics)', async () => {
    const content = 'a\nb\n';
    const p = await writeFixture(content);
    const reference = content.split('\n'); // ['a','b','']
    const { windowLines, totalLines } = await readLinesWindowed(p, 100, 110);
    expect(totalLines).toBe(reference.length);
    expect(windowLines).toEqual([]);
  });
});

describe('readLinesWindowed — maxBytes TOCTOU defense', () => {
  it('aborts with ReadLinesCapExceededError once raw bytes read exceed maxBytes', async () => {
    // The file is bigger than maxBytes — simulates a stat() check that passed
    // against a smaller expected size, but the actual read encounters more
    // data than authorized (e.g. the file grew after the check, on a shared
    // workspace). The read must abort rather than keep accumulating data.
    const content = 'x'.repeat(10_000);
    const p = await writeFixture(content);
    const maxBytes = 1_000;

    await expect(readLinesWindowed(p, 0, 10, 256, maxBytes)).rejects.toBeInstanceOf(
      ReadLinesCapExceededError,
    );
    await expect(readLinesWindowed(p, 0, 10, 256, maxBytes)).rejects.toThrow(String(maxBytes));
  });

  it('does not throw when the file stays within maxBytes', async () => {
    const content = 'a\nb\nc\n';
    const p = await writeFixture(content);
    const { totalLines } = await readLinesWindowed(p, 0, 10, 256, 1_000_000);
    expect(totalLines).toBe(4);
  });

  it('with no maxBytes provided (default), a large file is read normally (no cap applied)', async () => {
    const content = 'y'.repeat(50_000);
    const p = await writeFixture(content);
    const { totalLines } = await readLinesWindowed(p, 0, 10);
    expect(totalLines).toBe(1); // one line, no newline in content
  });
});
