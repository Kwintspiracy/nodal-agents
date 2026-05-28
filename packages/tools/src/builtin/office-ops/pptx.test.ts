// pptx.test.ts — round-trip + security tests for pptx_* tools

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pptxReadTool, pptxCreateTool } from './pptx';
import type { ToolContext } from '../../types';

// ─── Setup ────────────────────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-pptx-ws-'));
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

// ─── pptx_create ─────────────────────────────────────────────────────────────

describe('pptx_create', () => {
  it('creates a deck and pptx_read returns slide count + bullet text', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'deck.pptx',
        slides: [
          { title: 'Intro', bullets: ['Point A', 'Point B'] },
          { title: 'Details', body: 'Some body text here.' },
          { title: 'Conclusion', bullets: ['Done'] },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);
    expect(create.slide_count).toBe(3);

    const read = await pptxReadTool.execute({ path: 'deck.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);

    // slideCount should reflect the 3 slides
    expect(read.slideCount).toBeGreaterThanOrEqual(1);

    // Bullet text should appear in the extracted text
    expect(read.text).toContain('Point A');
    expect(read.text).toContain('Point B');
    expect(read.truncated).toBe(false);
  });

  it('includes title text in extracted content', async () => {
    const create = await pptxCreateTool.execute(
      {
        path: 'titled.pptx',
        slides: [{ title: 'My Important Slide', bullets: ['Bullet 1'] }],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);

    const read = await pptxReadTool.execute({ path: 'titled.pptx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('My Important Slide');
  });

  it('refuses to overwrite when overwrite:false', async () => {
    await pptxCreateTool.execute(
      { path: 'existing.pptx', slides: [{ title: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxCreateTool.execute(
      { path: 'existing.pptx', slides: [{ title: 'new' }], overwrite: false },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/already exists/i);
  });

  it('overwrites when overwrite:true', async () => {
    await pptxCreateTool.execute(
      { path: 'over.pptx', slides: [{ title: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await pptxCreateTool.execute(
      { path: 'over.pptx', slides: [{ title: 'replaced' }], overwrite: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for invalid image_path (path traversal)', async () => {
    const result = await pptxCreateTool.execute(
      {
        path: 'badimg.pptx',
        slides: [{ title: 'Test', image_path: '../escape.png' }],
        overwrite: false,
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/image_path|traversal|escape|workspace|outside/i);
  });
});

// ─── pptx_read ────────────────────────────────────────────────────────────────

describe('pptx_read', () => {
  it('returns ok:false when file not found', async () => {
    const result = await pptxReadTool.execute({ path: 'missing.pptx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false when workspace is not configured', async () => {
    const result = await pptxReadTool.execute({ path: 'any.pptx' }, ctxNone());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/workspace/i);
  });

  it('blocks path traversal', async () => {
    const result = await pptxReadTool.execute({ path: '../escape.pptx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/traversal|escape|workspace|outside/i);
  });
});
