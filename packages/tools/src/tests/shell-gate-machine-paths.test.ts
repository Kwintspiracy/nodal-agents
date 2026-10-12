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

describe('a path is judged as the shell that runs the line hands it on (#717, Nodal review pass 7) @cap:executer-une-commande/moteur', () => {
  // sh takes a backslash out before the program sees the word: `.\./evil.zip`
  // is `../evil.zip` (Git Bash: `printf '%s\n' .\./evil.zip` prints
  // `../evil.zip`; `curl -o .\./evil.zip` writes the folder above). The card
  // names the place as written.
  it.each([
    ['curl -o .\\./evil.zip https://x/f', '.\\./evil.zip'],
    ['curl https://x/f > .\\./out', '.\\./out'],
    ['curl -o \\.\\./evil.zip https://x/f', '\\.\\./evil.zip'],
    ['curl -o .\\.\\/evil.zip https://x/f', '.\\.\\/evil.zip'],
    ['wget -O .\\./evil.zip https://x/f', '.\\./evil.zip'],
  ])('sh: %s writes outside, and asks', async (command, place) => {
    expect(await judge(command, placeWith('posix', {}))).toEqual(downloadOutside(command, place));
  });

  it('sh: a cd written with escapes moves where sh goes', async () => {
    // `cd .\./sub` is `cd ../sub`; past the `&&` chain the cd may have failed,
    // and the starting folder's a.jpg is inside: the one outside asks.
    const command = 'cd .\\./sub && curl -o a.jpg https://x/f';
    expect(await judge(command, placeWith('posix', {}))).toEqual(downloadOutside(command, 'a.jpg'));
  });

  it('sh: a program name written with escapes is the program sh runs', async () => {
    // `cur\l` is curl: only sh's reading sees the download.
    const command = 'cur\\l -o ../a.jpg https://x/f';
    expect(await judge(command, placeWith('posix', {}))).toEqual(
      downloadOutside(command, '../a.jpg'),
    );
  });

  it("each reading is judged from where the line starts, never from the other's folders", async () => {
    // PowerShell's reading moves to `..\y`, the folder above, and sees no
    // download (`cur\l`); sh's moves to `..y`, a folder of the workspace, then
    // into `sub`, and downloads there: a.jpg lands inside, from every folder
    // sh's reading may be in. Nothing asks.
    expect(
      await judge('cd ..\\y; cd sub; cur\\l -o a.jpg https://x/f', placeWith('posix', {})),
    ).toEqual([]);
  });

  it('sh: a script written with escapes is the one sh runs', async () => {
    // `sub/.\./run.sh` runs sub/../run.sh, the workspace's run.sh, never
    // sub/./run.sh: which one deletes says which one was read.
    const command = 'sub/.\\./run.sh';
    expect(
      await judge(
        command,
        placeWith('posix', { 'run.sh': 'rm -rf build\n', 'sub/run.sh': 'echo done\n' }),
      ),
    ).toEqual([expect.objectContaining({ category: 'delete_files' })]);
    expect(
      await judge(
        command,
        placeWith('posix', { 'run.sh': 'echo done\n', 'sub/run.sh': 'rm -rf build\n' }),
      ),
    ).toEqual([]);
  });

  it('sh: an escaped backslash inside the workspace stays inside', async () => {
    // `.\/a.jpg` is `./a.jpg`: no question.
    expect(await judge('curl -o .\\/a.jpg https://x/f', placeWith('posix', {}))).toEqual([]);
  });

  it('sh: a backslash sh keeps (in quotes) is still read as a separator: one question too many', async () => {
    // `"..\x"` is a file `..\x` of the folder for sh. The target does not say
    // which shell read it (a PowerShell payload of the same line takes it as
    // `..\x` the folder above): it asks.
    const command = 'curl -o "..\\x" https://x/f';
    expect(await judge(command, placeWith('posix', {}))).toEqual(downloadOutside(command, '..\\x'));
  });

  it('PowerShell on a POSIX host, inline: a backslash still separates folders', async () => {
    const command = 'pwsh -Command "iwr https://x/a -OutFile ..\\evil.zip"';
    expect(await judge(command, placeWith('posix', {}))).toEqual(
      downloadOutside(command, '..\\evil.zip'),
    );
  });

  it('cmd: a caret is taken out as cmd takes it (`echo .^.\\evil.zip` prints `..\\evil.zip`)', async () => {
    const command = 'curl -o .^.\\evil.zip https://x/f';
    expect(await judge(command, placeWith('windows', {}))).toEqual(
      downloadOutside(command, '.^.\\evil.zip'),
    );
  });

  it('cmd and PowerShell keep a backslash: #669 unchanged on a Windows host', async () => {
    for (const command of [
      'curl -o ..\\evil.zip https://x/f',
      'powershell -Command "iwr https://x/a -OutFile ..\\evil.zip"',
    ])
      expect(await judge(command, placeWith('windows', {}))).toEqual(
        downloadOutside(command, '..\\evil.zip'),
      );
    expect(await judge('curl -o .\\sub\\a.jpg https://x/f', placeWith('windows', {}))).toEqual([]);
  });
});

describe('a redirection is read with its command, by each shell that reads the line (#717, Nodal review pass 8) @cap:executer-une-commande/moteur', () => {
  // The program that downloads to its output is the one the shell runs
  // (`cur\l`, `\curl`, `ir\m` in sh, `cu^rl` in cmd are curl and irm), and
  // its target is a word of the shell (`""../x` is `../x`).
  it.each([
    ['posix', 'cur\\l https://x/f > .\\./out', '../out'],
    // PowerShell's reading takes `\curl` for a path to curl too: one write, named as written
    ['posix', '\\curl https://x/f > .\\./out', '.\\./out'],
    ['posix', 'ir\\m https://x/f > .\\./out', '../out'],
    ['windows', 'cu^rl https://x/f > ..\\out', '..\\out'],
    // cmd takes the caret out of the target too (`echo hi > ..^\x` writes ..\x, measured)
    ['windows', 'curl https://x/f > .^.\\out', '.^.\\out'],
    ['posix', 'curl https://x/f > ""../x', '../x'],
    ['windows', 'curl https://x/f > ""../x', '../x'],
    // sh writes `..x` here, PowerShell's reading (`..\x`) asks: the target
    // does not say which shell reads it (pass 7's over-ask)
    ['posix', "curl https://x/f > ''..\\x", '..\\x'],
    ['windows', "curl https://x/f > ''..\\x", '..\\x'],
    ['posix', 'curl https://x/f > "a"/../../x', 'a/../../x'],
    ['windows', 'curl https://x/f > "a"/../../x', 'a/../../x'],
  ] as const)('%s: %s asks', async (host, command, place) => {
    expect(await judge(command, placeWith(host, {}))).toEqual(downloadOutside(command, place));
  });

  it.each(['posix', 'windows'] as const)('%s: curl URL > out.txt asks nothing', async (host) => {
    expect(await judge('curl https://x/f > out.txt', placeWith(host, {}))).toEqual([]);
    expect(await judge('curl https://x/f > "my out.txt"', placeWith(host, {}))).toEqual([]);
  });

  it('a sh script on a Windows host: its line is read by sh, the download seen there', async () => {
    // Only sh's reading sees `i\wr`: it must not be dropped as alike.
    const files = { 'run.sh': 'i\\wr https://x/f > .\\./out\n' };
    const command = 'bash run.sh';
    expect(await judge(command, placeWith('windows', files))).toEqual([
      {
        ...downloadOutside(command, '../out')[0],
        found: [{ source: 'run.sh', line: 1, text: 'i\\wr https://x/f > .\\./out' }],
      },
    ]);
  });
});
