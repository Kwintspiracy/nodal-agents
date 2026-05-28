// docx.test.ts — round-trip + security tests for docx_* tools

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docxReadTool, docxCreateTool, docxAppendParagraphsTool } from './docx';
import type { ToolContext } from '../../types';

// ─── Setup ────────────────────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-docx-ws-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function ctxNone(): ToolContext {
  return { ...ctx(), workspaces: undefined };
}

// ─── docx_create ─────────────────────────────────────────────────────────────

describe('docx_create', () => {
  it('creates a .docx and docx_read can retrieve the paragraph text', async () => {
    const create = await docxCreateTool.execute(
      {
        path: 'hello.docx',
        paragraphs: [
          { text: 'Hello, World!', heading: 1 },
          { text: 'This is a paragraph.', bold: false },
          { text: 'Bold text here.', bold: true },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const read = await docxReadTool.execute({ path: 'hello.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);

    // All three texts should be present
    expect(read.text).toContain('Hello, World!');
    expect(read.text).toContain('This is a paragraph.');
    expect(read.text).toContain('Bold text here.');
    expect(read.truncated).toBe(false);
  });

  it('returns paragraph list in paragraphs array', async () => {
    await docxCreateTool.execute(
      {
        path: 'paras.docx',
        paragraphs: [{ text: 'Para One' }, { text: 'Para Two' }],
        overwrite: false,
      },
      ctx(),
    );

    const read = await docxReadTool.execute({ path: 'paras.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.paragraphs).toContain('Para One');
    expect(read.paragraphs).toContain('Para Two');
  });

  it('refuses to overwrite when overwrite:false', async () => {
    await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'new' }], overwrite: false },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/already exists/i);
  });

  it('overwrites when overwrite:true', async () => {
    await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'replaced' }], overwrite: true },
      ctx(),
    );
    expect(result.ok).toBe(true);

    const read = await docxReadTool.execute({ path: 'doc.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('replaced');
  });
});

// ─── docx_read ────────────────────────────────────────────────────────────────

describe('docx_read', () => {
  it('returns ok:false when file not found', async () => {
    const result = await docxReadTool.execute({ path: 'missing.docx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false when workspace is not configured', async () => {
    const result = await docxReadTool.execute({ path: 'any.docx' }, ctxNone());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/workspace/i);
  });

  it('blocks path traversal', async () => {
    const result = await docxReadTool.execute({ path: '../escape.docx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/traversal|escape|workspace|outside/i);
  });
});

// ─── docx_append_paragraphs ───────────────────────────────────────────────────

describe('docx_append_paragraphs', () => {
  it('appends paragraphs — resulting document contains original + new text', async () => {
    await docxCreateTool.execute(
      { path: 'app.docx', paragraphs: [{ text: 'Original content.' }], overwrite: false },
      ctx(),
    );

    const append = await docxAppendParagraphsTool.execute(
      {
        path: 'app.docx',
        paragraphs: [{ text: 'Appended paragraph.' }],
      },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);
    expect(append.paragraphs_appended).toBe(1);

    const read = await docxReadTool.execute({ path: 'app.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Original content.');
    expect(read.text).toContain('Appended paragraph.');
  });
});
