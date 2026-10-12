// shell-gate-machine-paths.test.ts — the gate judges the text, not the machine
// it runs on (#717, CI Linux on PR #721).
//
// A backslash is a folder separator for cmd and PowerShell, and PowerShell
// runs on Linux too: `..\evil.zip` names the folder above on every OS. The
// gate resolved folder moves and download targets with the machine's `path`:
// on Linux, `/ws/..\evil.zip` is a file of the workspace, and the download
// outside passed. Every case here runs with `node:path` as Linux has it, so it
// fails the same way on any machine.

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.posix, default: actual.posix };
});

import { resolve } from 'node:path';
import { DEFAULT_SHELL_POLICY } from '@nodal-agents/shared';
import { judgeShellChecklist, type ShellPlace } from '../shell-checklist';

const root = resolve('/nodal-fake-ws');

/** A workspace at `root` holding `files`; a file out of it is read nowhere. */
function placeWith(host: ShellPlace['host'], files: Record<string, string>): ShellPlace {
  const byPath = new Map(Object.entries(files).map(([rel, text]) => [resolve(root, rel), text]));
  const inside = (p: string) => resolve(p).startsWith(root);
  return {
    cwd: root,
    host,
    inWorkspace: async (p) => inside(p),
    leadsTo: async () => null,
    readSource: async (p) => {
      if (!inside(p)) return { kind: 'unread', why: 'outside_workspaces' };
      const text = byPath.get(resolve(p));
      return text === undefined
        ? { kind: 'unread', why: 'not_found' }
        : { kind: 'text', text, bytes: text.length };
    },
  };
}

const judge = (command: string, place: ShellPlace) =>
  judgeShellChecklist([command], DEFAULT_SHELL_POLICY, place);

const downloadOutside = (command: string, place: string) => [
  {
    category: 'download',
    state: 'ask',
    details: [command],
    outside: [{ command, places: [place] }],
  },
];

const DELETES = 'del /q important.txt\r\n';
const HARMLESS = 'echo done\r\n';

describe('the gate judges the text, not the machine it runs on (#717) @cap:executer-une-commande/moteur', () => {
  it('cmd: a download target written with backslashes leaves the workspace', async () => {
    const command = 'curl -o ..\\a.jpg https://x/a';
    expect(await judge(command, placeWith('windows', {}))).toEqual(
      downloadOutside(command, '..\\a.jpg'),
    );
  });

  it('PowerShell: a Set-Location, then a download, judged from both folders', async () => {
    const files = { 'run.ps1': 'Set-Location sub\niwr https://x/a -OutFile ..\\evil.zip\n' };
    const command = 'powershell -File run.ps1';
    expect(await judge(command, placeWith('windows', files))).toEqual([
      {
        ...downloadOutside(command, '..\\evil.zip')[0],
        found: [{ source: 'run.ps1', line: 2, text: 'iwr https://x/a -OutFile ..\\evil.zip' }],
      },
    ]);
  });

  it('PowerShell on a POSIX host: a backslash still separates folders', async () => {
    const files = { 'run.ps1': 'iwr https://x/a -OutFile ..\\evil.zip\n' };
    const command = 'pwsh -File run.ps1';
    expect(await judge(command, placeWith('posix', files))).toEqual([
      {
        ...downloadOutside(command, '..\\evil.zip')[0],
        found: [{ source: 'run.ps1', line: 1, text: 'iwr https://x/a -OutFile ..\\evil.zip' }],
      },
    ]);
  });

  it('a folder move written with backslashes enters each folder it names', async () => {
    // `cd sub\deeper && ..\run.bat` runs sub\run.bat: which one deletes says
    // which one was read.
    const command = 'cd sub\\deeper && ..\\run.bat';
    expect(
      await judge(command, placeWith('windows', { 'run.bat': HARMLESS, 'sub/run.bat': DELETES })),
    ).toEqual([expect.objectContaining({ category: 'delete_files' })]);
    expect(
      await judge(command, placeWith('windows', { 'run.bat': DELETES, 'sub/run.bat': HARMLESS })),
    ).toEqual([]);
  });

  it('a download from a folder entered with backslashes is judged from there', async () => {
    // From sub\deeper, `..\..\a.jpg` is the workspace's own a.jpg; from the
    // starting folder (the cd may fail), `..\..\a.jpg` is outside.
    const inside = 'cd sub\\deeper && curl -o ..\\..\\a.jpg https://x/a';
    expect(await judge(inside, placeWith('windows', {}))).toEqual([]);
    const outside = 'cd sub\\deeper & curl -o ..\\..\\a.jpg https://x/a';
    expect(await judge(outside, placeWith('windows', {}))).toEqual(
      downloadOutside(outside, '..\\..\\a.jpg'),
    );
  });
});
