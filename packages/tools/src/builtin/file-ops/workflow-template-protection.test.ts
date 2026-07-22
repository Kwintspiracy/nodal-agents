// workflow-template-protection.test.ts — P4 (causality study, 2026-07-22):
// shared canonical ComfyUI workflow templates (workflows/*.json in the
// entity-wide SHARED workspace) are READ-ONLY to file_write/file_edit.
//
// Born from a live incident: a delegated worker (ComfyArtist) called
// file_edit directly on the shared canonical `workflows/Krea2_Turbo.json`,
// overwriting its prompt/seed/aspect_ratio scene-to-scene and contaminating
// every later run that shared the template. The intended pattern is
// runtime parameter injection (the ComfyUI skill's `run_workflow --args`),
// never mutating the template file.
//
// Exercises the full path through executeTool (real DB, real approval gate)
// with real temp-dir workspaces — proves the WIRING, not just the pure
// predicate (isProtectedWorkflowTemplatePath, tested separately below).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { executeTool } from '../../execute';
import { SHARED_WORKSPACE_LABEL, isProtectedWorkflowTemplatePath } from './workspace';
import { fileWriteTool } from './file-write';
import { fileEditTool } from './file-edit';
import type { ToolContext, ExecuteOptions } from '../../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let SHARED_ROOT: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  SHARED_ROOT = await mkdtemp(join(tmpdir(), 'nodal-shared-wf-'));
  await mkdir(join(SHARED_ROOT, 'workflows'), { recursive: true });
  await mkdir(join(SHARED_ROOT, 'outputs'), { recursive: true });
  await mkdir(join(SHARED_ROOT, 'scripts'), { recursive: true });
});

afterEach(async () => {
  await rm(SHARED_ROOT, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: SHARED_WORKSPACE_LABEL, path: SHARED_ROOT }],
  };
}

// fully_autonomous so a would-be D1 overwrite-approval gate never intercepts
// the call before we can observe the P4 fail-loud outcome.
function opts(): ExecuteOptions {
  return {
    approvalRules: [],
    autonomy: 'fully_autonomous',
    onApprovalRequired: async () => {},
  };
}

describe('P4 — workflow template protection — file_write', () => {
  it('fails loud on workflows/foo.json with the steering error, and does NOT touch the file', async () => {
    const target = join(SHARED_ROOT, 'workflows', 'foo.json');
    await writeFile(target, '{"original":true}', 'utf8');

    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/workflows/foo.json`, content: '{"mutated":true}' },
      ctx(),
      opts(),
    );

    expect(result.outcome).toBe('success'); // tool ran; its OWN output says ok:false
    const output =
      result.outcome === 'success' ? (result.output as { ok: boolean; reason?: string }) : null;
    expect(output?.ok).toBe(false);
    expect(output?.reason).toMatch(/read-only/i);
    expect(output?.reason).toMatch(/run_workflow/i);

    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe('{"original":true}'); // never overwritten
  });

  it('still succeeds writing outputs/foo.png (non-template path)', async () => {
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/outputs/foo.png`, content: 'binary-ish' },
      ctx(),
      opts(),
    );
    expect(result.outcome).toBe('success');
    const output = result.outcome === 'success' ? (result.output as { ok: boolean }) : null;
    expect(output?.ok).toBe(true);
    const onDisk = await readFile(join(SHARED_ROOT, 'outputs', 'foo.png'), 'utf8');
    expect(onDisk).toBe('binary-ish');
  });

  it('still succeeds writing scripts/x.py (non-template path)', async () => {
    const result = await executeTool(
      fileWriteTool,
      { path: `${SHARED_WORKSPACE_LABEL}/scripts/x.py`, content: 'print("hi")' },
      ctx(),
      opts(),
    );
    expect(result.outcome).toBe('success');
    const output = result.outcome === 'success' ? (result.output as { ok: boolean }) : null;
    expect(output?.ok).toBe(true);
  });
});

describe('P4 — workflow template protection — file_edit', () => {
  it('fails loud on workflows/foo.json with the steering error, and does NOT touch the file', async () => {
    const target = join(SHARED_ROOT, 'workflows', 'foo.json');
    await writeFile(target, '{"seed": 1}', 'utf8');

    const result = await executeTool(
      fileEditTool,
      {
        path: `${SHARED_WORKSPACE_LABEL}/workflows/foo.json`,
        old_string: '"seed": 1',
        new_string: '"seed": 999',
      },
      ctx(),
      opts(),
    );

    expect(result.outcome).toBe('success');
    const output =
      result.outcome === 'success' ? (result.output as { ok: boolean; reason?: string }) : null;
    expect(output?.ok).toBe(false);
    expect(output?.reason).toMatch(/read-only/i);
    expect(output?.reason).toMatch(/run_workflow/i);

    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe('{"seed": 1}');
  });

  it('still succeeds editing outputs/foo.png-adjacent scripts/x.py (non-template path)', async () => {
    const target = join(SHARED_ROOT, 'scripts', 'x.py');
    await writeFile(target, 'print("hi")', 'utf8');
    const result = await executeTool(
      fileEditTool,
      { path: `${SHARED_WORKSPACE_LABEL}/scripts/x.py`, old_string: 'hi', new_string: 'bye' },
      ctx(),
      opts(),
    );
    expect(result.outcome).toBe('success');
    const output = result.outcome === 'success' ? (result.output as { ok: boolean }) : null;
    expect(output?.ok).toBe(true);
    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe('print("bye")');
  });
});

describe('isProtectedWorkflowTemplatePath — pure predicate', () => {
  it.each([
    ['workflows/foo.json', true],
    ['workflows/nested/foo.json', true],
    ['a/workflows/foo.json', true],
    ['Workflows/Foo.JSON', true], // case-insensitive
    ['workflows\\foo.json', true], // Windows separators
    ['outputs/foo.png', false],
    ['scripts/x.py', false],
    ['workflows.json', false], // no directory segment, just a filename
    ['not-workflows/foo.json', false], // segment must be exactly "workflows"
    ['workflows/foo.txt', false], // not .json
    ['foo.json', false], // no directory at all
  ])('%s → %s', (relPath, expected) => {
    expect(isProtectedWorkflowTemplatePath(relPath)).toBe(expected);
  });
});
