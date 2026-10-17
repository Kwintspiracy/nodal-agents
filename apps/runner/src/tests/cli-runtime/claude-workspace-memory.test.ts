// claude-workspace-memory.test.ts — what Claude really receives of a workspace's
// CLAUDE.md files, through a REAL process, on the runtime turn.
//
// `--setting-sources user` (#782) stops Claude from loading them, so Nodal reads
// them and writes them after the persona in the `--append-system-prompt-file`.
// A fake `claude` on PATH copies that file at launch; the assertions are on the
// bytes it received, not on a call.
//
// Mutations verified (each reverted afterwards): `composeClaudePersona` returning
// the bare personality → the content tests red; the roots reduced to `cwd` only
// is covered by the unit tests of the reader.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeClaudePersona, runClaudeTurn } from '../../cli-runtime/claude-turn.ts';

const isWindows = process.platform === 'win32';
let root: string;
let capture: string;
let previousPath: string | undefined;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nodal-claude-mem-')));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  capture = join(root, 'captured-persona.txt');
  const script = join(binDir, 'fake-claude.js');
  await writeFile(
    script,
    `const fs = require('fs');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(a[a.indexOf('--append-system-prompt-file') + 1], 'utf8'));
process.stdout.write(JSON.stringify({ type: 'result', result: 'OK', session_id: 's1', is_error: false, num_turns: 1 }) + '\\n');
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

async function workspace(name: string, files: Record<string, string>): Promise<string> {
  const ws = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(ws, rel, '..'), { recursive: true });
    await writeFile(join(ws, rel), content);
  }
  await mkdir(ws, { recursive: true });
  return ws;
}

const turn = (cwd: string, extraWriteDirs?: string[]) =>
  runClaudeTurn({
    message: 'hello',
    personality: 'PERSONA-FROM-DB',
    cwd,
    ...(extraWriteDirs ? { extraWriteDirs } : {}),
    mode: 'read',
    shellTools: [],
    timeoutMs: 30_000,
  });

describe('the persona file a runtime turn hands to claude @cap:travailler-sur-des-fichiers/moteur', () => {
  it("carries the persona, then the workspace's CLAUDE.md quoted, then nothing more", async () => {
    const ws = await workspace('with-md', {
      'CLAUDE.md': 'Always begin with PINEAPPLE. See @rules.md',
      'rules.md': 'IMPORTED-RULE',
      'CLAUDE.local.md': 'MY-LOCAL-NOTE',
    });
    const result = await turn(ws);
    expect(result.errorDetail).toBeNull();
    expect(result.isError).toBe(false);
    expect(await readFile(capture, 'utf8')).toBe(
      'PERSONA-FROM-DB\n\n' +
        '<project-instructions source="workspace files, quoted verbatim">\n' +
        '<file path="CLAUDE.md">\nAlways begin with PINEAPPLE. See @rules.md\n</file>\n' +
        '<file path="rules.md" imported-from="CLAUDE.md">\nIMPORTED-RULE\n</file>\n' +
        '<file path="CLAUDE.local.md">\nMY-LOCAL-NOTE\n</file>\n' +
        '</project-instructions>',
    );
  });

  it('is the bare persona when the workspace has no instructions', async () => {
    const ws = await workspace('without-md', { 'readme.txt': 'x' });
    await turn(ws);
    expect(await readFile(capture, 'utf8')).toBe('PERSONA-FROM-DB');
  });

  it('never reads the instructions of another attached folder, nor of a parent', async () => {
    const parent = await workspace('parent-case', { 'CLAUDE.md': 'PARENT-ONLY' });
    const ws = join(parent, 'repo');
    await mkdir(ws, { recursive: true });
    const other = await workspace('other-folder', { 'CLAUDE.md': 'OTHER-FOLDER-ONLY' });
    await writeFile(join(ws, 'CLAUDE.md'), 'REPO-ONLY');
    await turn(ws, [other]);
    const received = await readFile(capture, 'utf8');
    expect(received).toContain('REPO-ONLY');
    expect(received).not.toContain('PARENT-ONLY');
    expect(received).not.toContain('OTHER-FOLDER-ONLY');
  });

  it('composeClaudePersona is the one place that builds it', async () => {
    const ws = await workspace('compose', { 'CLAUDE.md': 'ONE' });
    const persona = await composeClaudePersona({ personality: 'P', cwd: ws });
    expect(persona.startsWith('P\n\n<project-instructions ')).toBe(true);
  });
});
