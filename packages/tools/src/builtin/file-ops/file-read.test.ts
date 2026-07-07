// file-read.test.ts — file_read tool: small-file behavior unchanged, the new
// bounded-memory streaming path for 1 MiB–50 MiB files matches the reference
// `raw.split('\n').slice(...)` semantics exactly, and the absolute 50 MiB hard
// cap refuses reads outright even with offset/limit supplied.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReadTool } from './file-read';
import { MAX_READ_FILE_BYTES, MAX_READ_BYTES } from './workspace';
import type { ToolContext } from '../../types';

let WORKSPACE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-fileread-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
  };
}

/** Write `content` to `path` without ever holding the whole thing in one string/buffer. */
async function writeChunked(path: string, chunk: string, repeat: number): Promise<void> {
  const handle = await open(path, 'w');
  try {
    const buf = Buffer.from(chunk, 'utf8');
    for (let i = 0; i < repeat; i++) {
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
}

describe('file_read — small file (< 1 MiB): unchanged behavior', () => {
  it('reads whole content and paginates by line', async () => {
    const p = join(WORKSPACE, 'small.txt');
    await writeChunked(p, 'line1\nline2\nline3\n', 1);
    const r = await fileReadTool.execute({ path: 'small.txt' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    // join('\n') of split('\n') reconstructs the original content exactly.
    expect(r.content).toBe('line1\nline2\nline3\n');
    expect(r.total_lines).toBe(4); // trailing '\n' => empty last line counted
    expect(r.truncated).toBe(false);
  });
});

describe('file_read — medium file (1 MiB < size <= 50 MiB): streaming window matches reference', () => {
  it("offset/limit window matches raw.split('\\n').slice(...) exactly, incl. trailing newline + CRLF", async () => {
    const p = join(WORKSPACE, 'medium.txt');
    // Build ~2 MiB of content: many CRLF lines plus a final trailing '\n'.
    const lineTemplate = 'row-XXXXXX,value,data,more,columns,here\r\n';
    const lineBytes = Buffer.byteLength(lineTemplate, 'utf8');
    const targetBytes = 2 * 1024 * 1024;
    const repeats = Math.ceil(targetBytes / lineBytes);

    // Build the exact reference content in memory once (repeats * ~40 bytes
    // is small enough — only the fixture-authoring step, not the tool path).
    let full = '';
    for (let i = 0; i < repeats; i++) {
      full += lineTemplate.replace('XXXXXX', String(i).padStart(6, '0'));
    }
    await writeChunked(p, full, 1);

    const info = await import('node:fs/promises').then((m) => m.stat(p));
    expect(info.size).toBeGreaterThan(MAX_READ_BYTES);
    expect(info.size).toBeLessThanOrEqual(MAX_READ_FILE_BYTES);

    const reference = full.split('\n');

    const offset = 1000; // 1-based
    const limit = 500;
    const r = await fileReadTool.execute({ path: 'medium.txt', offset, limit }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);

    const startIdx = offset - 1;
    const endIdx = Math.min(reference.length, startIdx + limit);
    const expectedContent = reference.slice(startIdx, endIdx).join('\n');

    expect(r.total_lines).toBe(reference.length);
    expect(r.start_line).toBe(offset);
    expect(r.end_line).toBe(endIdx);
    expect(r.content).toBe(expectedContent);
    // CRLF preserved: every line in the window still ends with '\r'.
    expect(r.content.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });

  it('a window covering the very end of the file reflects the trailing-newline empty last line', async () => {
    const p = join(WORKSPACE, 'medium-tail.txt');
    const lineTemplate = `x`.repeat(60) + '\n';
    const lineBytes = Buffer.byteLength(lineTemplate, 'utf8');
    const targetBytes = 1.5 * 1024 * 1024;
    const repeats = Math.ceil(targetBytes / lineBytes);
    let full = '';
    for (let i = 0; i < repeats; i++) full += lineTemplate;
    await writeChunked(p, full, 1);

    const reference = full.split('\n'); // last element is '' (trailing newline)
    const r = await fileReadTool.execute(
      { path: 'medium-tail.txt', offset: reference.length - 2, limit: 10 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.total_lines).toBe(reference.length);
    expect(r.truncated).toBe(false);
    const startIdx = reference.length - 2 - 1;
    expect(r.content).toBe(reference.slice(startIdx, reference.length).join('\n'));
    // Last line of the window is the empty string produced by the trailing '\n'.
    expect(r.content.split('\n').at(-1)).toBe('');
  });

  it('refuses a >1 MiB file without offset/limit (pagination still mandatory)', async () => {
    const p = join(WORKSPACE, 'medium-noargs.txt');
    await writeChunked(p, 'x'.repeat(1024 * 1024 + 10), 1);
    const r = await fileReadTool.execute({ path: 'medium-noargs.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.reason).toContain('offset');
  });
});

describe('file_read — hard cap (> 50 MiB): refused even with offset/limit', () => {
  it('refuses a file above MAX_READ_FILE_BYTES with a clear reason, even with pagination', async () => {
    const p = join(WORKSPACE, 'huge.bin');
    const chunk = 'x'.repeat(1024 * 1024); // 1 MiB chunk, written repeatedly (no full-file string held)
    const chunksNeeded = Math.ceil(MAX_READ_FILE_BYTES / (1024 * 1024)) + 1; // > cap
    await writeChunked(p, chunk, chunksNeeded);

    const info = await import('node:fs/promises').then((m) => m.stat(p));
    expect(info.size).toBeGreaterThan(MAX_READ_FILE_BYTES);

    const r = await fileReadTool.execute({ path: 'huge.bin', offset: 1, limit: 100 }, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal for file above the hard cap');
    expect(r.reason).toContain('50');
    expect(r.reason.toLowerCase()).toMatch(/cap|too large|exceed/i);
  }, 30000);
});
