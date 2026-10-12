// shell-folder-moves-gate.test.ts — the gate reads each script from the folder
// it really runs in (#717).
//
// A folder move made in a child process (`cmd /c "cd x"`, `bash -c "cd x"`,
// `(cd x)`) stays there; a script run in the line's own process (a batch file,
// a `.ps1`, what sh's `.` reads) leaves the line where its body ends. Each case
// runs the real checklist on real script bodies, through a fake filesystem,
// and asserts its verdict: which file was read is what was judged.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_SHELL_POLICY } from '@nodal-agents/shared';
import { judgeShellChecklist, type ShellPlace } from '../shell-checklist';

const root = resolve('/nodal-fake-ws');

/** A workspace at `root` holding `files` (paths relative to it, `/`-separated). */
function placeWith(host: ShellPlace['host'], files: Record<string, string>): ShellPlace {
  const byPath = new Map(
    Object.entries(files).map(([rel, text]) => [resolve(root, rel).toLowerCase(), text]),
  );
  return {
    cwd: root,
    host,
    inWorkspace: async (p) => resolve(p).toLowerCase().startsWith(root.toLowerCase()),
    leadsTo: async () => null,
    readSource: async (p) => {
      const text = byPath.get(resolve(p).toLowerCase());
      return text === undefined
        ? { kind: 'unread', why: 'not_found' }
        : { kind: 'text', text, bytes: text.length };
    },
  };
}

const judge = (command: string, place: ShellPlace) =>
  judgeShellChecklist([command], DEFAULT_SHELL_POLICY, place);

/** The kinds of action the checklist held the command for. */
const kinds = async (command: string, place: ShellPlace) =>
  (await judge(command, place)).map((r) => r.category);

// The file that deletes and the one that does not, in the folder the line
// starts in and in `sub`: which one is judged says which one was read.
const DELETE_HERE = { bat: 'del /q important.txt\r\n', sh: 'rm -rf build\n' };
const HARMLESS = { bat: 'echo done\r\n', sh: 'echo done\n' };

describe("a script run in the line's own process leaves the line where it ends (#717) @cap:executer-une-commande/moteur", () => {
  it('cmd: the batch file after one that changes folder is read from that folder', async () => {
    for (const command of ['prepare.bat && cleanup.bat', 'call prepare.bat & cleanup.bat']) {
      // prepare.bat moves into sub: sub's cleanup.bat runs, and deletes.
      expect(
        await kinds(
          command,
          placeWith('windows', {
            'prepare.bat': '@echo off\r\ncd sub\r\n',
            'cleanup.bat': HARMLESS.bat,
            'sub/cleanup.bat': DELETE_HERE.bat,
          }),
        ),
        command,
      ).toEqual(['delete_files']);
      // prepare.bat stays: the starting folder's cleanup.bat runs, and does not.
      expect(
        await kinds(
          command,
          placeWith('windows', {
            'prepare.bat': '@echo off\r\n',
            'cleanup.bat': HARMLESS.bat,
            'sub/cleanup.bat': DELETE_HERE.bat,
          }),
        ),
        command,
      ).toEqual([]);
    }
  });

  it("cmd: a batch file's setlocal takes its moves back at its end, and at endlocal", async () => {
    for (const setup of [
      '@echo off\r\nsetlocal\r\ncd sub\r\n',
      '@echo off\r\nsetlocal\r\ncd sub\r\nendlocal\r\n',
      '@echo off\r\nsetlocal & cd sub & endlocal\r\n',
    ]) {
      expect(
        await kinds(
          'prepare.bat && cleanup.bat',
          placeWith('windows', {
            'prepare.bat': setup,
            'cleanup.bat': DELETE_HERE.bat,
            'sub/cleanup.bat': HARMLESS.bat,
          }),
        ),
        setup,
      ).toEqual(['delete_files']);
    }
    // Inside the batch file, a script after endlocal runs from the folder restored.
    expect(
      await kinds(
        'prepare.bat',
        placeWith('windows', {
          'prepare.bat': 'setlocal\r\ncd sub\r\nendlocal\r\ncall cleanup.bat\r\n',
          'cleanup.bat': DELETE_HERE.bat,
          'sub/cleanup.bat': HARMLESS.bat,
        }),
      ),
    ).toEqual(['delete_files']);
  });

  it('sh: what `.` reads moves the line; a script run directly does not', async () => {
    const files = {
      'env.sh': 'cd sub\n',
      'cleanup.sh': HARMLESS.sh,
      'sub/cleanup.sh': DELETE_HERE.sh,
    };
    expect(await kinds('. ./env.sh && ./cleanup.sh', placeWith('posix', files))).toEqual([
      'delete_files',
    ]);
    expect(await kinds('./env.sh && ./cleanup.sh', placeWith('posix', files))).toEqual([]);
    expect(await kinds('bash env.sh && ./cleanup.sh', placeWith('posix', files))).toEqual([]);
  });

  it('PowerShell: a .ps1 a script runs leaves it in the location the .ps1 ends in', async () => {
    const files = {
      'run.ps1': '.\\env.ps1\n.\\cleanup.ps1\n',
      'env.ps1': 'Set-Location sub\n',
      'cleanup.ps1': 'Get-Date\n',
      'sub/cleanup.ps1': 'Remove-Item -Recurse build\n',
    };
    expect(await kinds('powershell -File run.ps1', placeWith('windows', files))).toEqual([
      'delete_files',
    ]);
    // A child PowerShell keeps its location to itself.
    expect(
      await kinds(
        'powershell -File run.ps1',
        placeWith('windows', { ...files, 'run.ps1': 'powershell -File env.ps1\n.\\cleanup.ps1\n' }),
      ),
    ).toEqual([]);
  });

  it('a script of the line that is not read leaves the folder unknown: what follows asks', async () => {
    // `prepare.bat` is not in the folder: the shell takes it from the PATH, and
    // where it leaves the line is not known. cleanup.bat is not read from a guess.
    const reasons = await judge(
      'call prepare.bat & cleanup.bat',
      placeWith('windows', { 'cleanup.bat': HARMLESS.bat }),
    );
    expect(reasons).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: ['call prepare.bat & cleanup.bat'],
        unread: [{ source: 'cleanup.bat', why: 'decided_at_run_time' }],
      },
    ]);
  });
});

describe('a folder move made in a child process stays there (#717) @cap:executer-une-commande/moteur', () => {
  it.each([
    ['cmd /c "cd decoy" & cleanup.bat', 'windows'],
    ['powershell -Command "cd decoy" & cleanup.bat', 'windows'],
    ['cd decoy | more & cleanup.bat', 'windows'],
    ['bash -c "cd decoy" && ./cleanup.sh', 'posix'],
    ['(cd decoy) && ./cleanup.sh', 'posix'],
    ['cd decoy | cat; ./cleanup.sh', 'posix'],
    ['cd decoy & ./cleanup.sh', 'posix'],
  ] as const)('%s reads the starting folder’s cleanup', async (command, host) => {
    const ext = host === 'windows' ? 'bat' : 'sh';
    const place = placeWith(host, {
      [`cleanup.${ext}`]: host === 'windows' ? DELETE_HERE.bat : DELETE_HERE.sh,
      [`decoy/cleanup.${ext}`]: host === 'windows' ? HARMLESS.bat : HARMLESS.sh,
    });
    expect(await kinds(command, place)).toEqual(['delete_files']);
  });

  it("a child's own later commands run where it moved", async () => {
    const files = { 'cleanup.sh': HARMLESS.sh, 'sub/cleanup.sh': DELETE_HERE.sh };
    expect(await kinds('bash -c "cd sub && ./cleanup.sh"', placeWith('posix', files))).toEqual([
      'delete_files',
    ]);
    expect(await kinds('(cd sub && ./cleanup.sh)', placeWith('posix', files))).toEqual([
      'delete_files',
    ]);
    // and not past its end
    expect(await kinds('(cd sub) && ./cleanup.sh', placeWith('posix', files))).toEqual([]);
  });

  it("a script line's child keeps its move from the script's next lines", async () => {
    expect(
      await kinds(
        'prepare.bat',
        placeWith('windows', {
          'prepare.bat': 'cmd /c "cd sub"\r\ncall cleanup.bat\r\n',
          'cleanup.bat': DELETE_HERE.bat,
          'sub/cleanup.bat': HARMLESS.bat,
        }),
      ),
    ).toEqual(['delete_files']);
  });
});

describe('where a download lands follows the same folder moves (#717) @cap:executer-une-commande/moteur', () => {
  const download = (command: string) => ({
    category: 'download',
    state: 'ask',
    details: [command],
    outside: [{ command, places: ['a.zip'] }],
  });

  it("a script run in the line's process that leaves the workspace takes the download out with it", async () => {
    for (const [command, host, files] of [
      ['prepare.bat && curl -o a.zip https://x/a', 'windows', { 'prepare.bat': 'cd ..\r\n' }],
      ['. ./env.sh && curl -o a.zip https://x/a', 'posix', { 'env.sh': 'cd ..\n' }],
    ] as const) {
      expect(await judge(command, placeWith(host, files)), command).toEqual([download(command)]);
      // the same script, staying: the download lands in the workspace
      const staying = Object.fromEntries(Object.keys(files).map((f) => [f, 'echo done\n']));
      expect(await judge(command, placeWith(host, staying)), command).toEqual([]);
    }
  });

  it('a child that leaves the workspace does not take the download with it', async () => {
    for (const [command, host] of [
      ['cmd /c "cd .." & curl -o a.zip https://x/a', 'windows'],
      ['bash -c "cd .." && curl -o a.zip https://x/a', 'posix'],
      ['(cd ..) && curl -o a.zip https://x/a', 'posix'],
    ] as const) {
      expect(await judge(command, placeWith(host, {})), command).toEqual([]);
    }
    // but one inside the child lands where the child is
    const inside = 'bash -c "cd .. && curl -o a.zip https://x/a"';
    expect(await judge(inside, placeWith('posix', {}))).toEqual([download(inside)]);
  });
});
