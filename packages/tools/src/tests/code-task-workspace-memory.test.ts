// code-task-workspace-memory.test.ts — what a `code_task` run hands to Claude of
// the workspace's CLAUDE.md files, through a REAL process.
//
// `--setting-sources user` (#782) stops Claude from loading them; the runtime
// turn and `code_task` both give them back as plain text, from the one reader
// (workspace-memory.ts). A fake `claude` on PATH copies the file named by
// `--append-system-prompt-file` at launch and reports whether the path still
// exists afterwards: the assertions are on the bytes it received and on the
// temp file being gone.
//
// Mutations verified (each reverted afterwards): the `appendSystemPromptFile`
// option not passed → the content test red; the `rm` in the finally removed →
// the "temp file removed" test red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { codeTaskTool } from '../builtin/code-task';
import { buildProviderArgs } from '../builtin/code-task/providers';
import type { ToolContext } from '../types';

const isWindows = process.platform === 'win32';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let root: string;
let ws: string;
let capture: string;
let capturedPath: string;
let previousPath: string | undefined;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  root = await realpath(await mkdtemp(join(tmpdir(), 'nodal-ct-mem-')));
  const binDir = join(root, 'bin');
  ws = join(root, 'ws');
  await mkdir(binDir, { recursive: true });
  await mkdir(ws, { recursive: true });
  capture = join(root, 'captured.txt');
  capturedPath = join(root, 'captured-path.txt');

  const script = join(binDir, 'fake-claude.js');
  await writeFile(
    script,
    `const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { process.stdout.write('9.9.9 (fake)\\n'); process.exit(0); }
const i = a.indexOf('--append-system-prompt-file');
if (i !== -1) {
  fs.writeFileSync(${JSON.stringify(capturedPath)}, a[i + 1]);
  fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(a[i + 1], 'utf8'));
}
process.stdout.write(JSON.stringify({ type: 'result', result: 'OK', session_id: 's1', is_error: false, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
`,
  );
  if (isWindows) {
    await writeFile(
      join(binDir, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    const shim = join(binDir, 'claude');
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(shim, 0o755);
  }
  previousPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}${isWindows ? ';' : ':'}${previousPath ?? ''}`;
});

afterAll(async () => {
  if (previousPath !== undefined) process.env['PATH'] = previousPath;
  await rm(root, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: seed.jobId,
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

const run = (extra: Record<string, unknown> = {}) =>
  codeTaskTool.execute(
    {
      purpose: 'memory',
      provider: 'claude',
      task: 'x',
      mode: 'read',
      fresh: true,
      ...extra,
    } as never,
    ctx(),
  ) as Promise<{ resultText: string; isError: boolean }>;

describe('the system prompt file a code_task run hands to claude @cap:travailler-sur-des-fichiers/moteur', () => {
  it('carries the workspace CLAUDE.md files, quoted, from the cwd chain only', async () => {
    await writeFile(join(ws, 'CLAUDE.md'), 'ROOT-RULE: always begin with PINEAPPLE');
    await mkdir(join(ws, 'pkg'), { recursive: true });
    await writeFile(join(ws, 'pkg', 'CLAUDE.md'), 'PKG-RULE');
    await mkdir(join(ws, 'elsewhere'), { recursive: true });
    await writeFile(join(ws, 'elsewhere', 'CLAUDE.md'), 'NOT-IN-THE-CHAIN');

    const out = await run({ cwd: 'pkg' });

    expect(out.isError).toBe(false);
    expect(await readFile(capture, 'utf8')).toBe(
      '<project-instructions source="workspace files, quoted verbatim">\n' +
        '<file path="CLAUDE.md">\nROOT-RULE: always begin with PINEAPPLE\n</file>\n' +
        '<file path="pkg/CLAUDE.md">\nPKG-RULE\n</file>\n' +
        '</project-instructions>',
    );
  });

  it('removes its temp file when the run is over', async () => {
    await writeFile(join(ws, 'CLAUDE.md'), 'ANYTHING');
    await run();
    const received = await readFile(capturedPath, 'utf8');
    await expect(access(received)).rejects.toThrow();
  });

  it('passes no file at all when the workspace has no instructions', async () => {
    await rm(join(ws, 'CLAUDE.md'), { force: true });
    await rm(join(ws, 'pkg'), { recursive: true, force: true });
    await rm(join(ws, 'elsewhere'), { recursive: true, force: true });
    await rm(capturedPath, { force: true });
    await run();
    await expect(access(capturedPath)).rejects.toThrow();
  });

  it('codex never carries the flag: it reads its own AGENTS.md', () => {
    const args = buildProviderArgs('codex', 'read', {
      appendSystemPromptFile: '/tmp/x',
      platform: 'linux',
    });
    expect(args).not.toContain('--append-system-prompt-file');
    expect(buildProviderArgs('claude', 'read', { appendSystemPromptFile: '/tmp/x' })).toContain(
      '--append-system-prompt-file',
    );
  });
});
