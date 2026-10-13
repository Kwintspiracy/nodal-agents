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

/**
 * A workspace at `root` holding `files` (paths relative to it, `/`-separated).
 * A file out of it is read nowhere, as the gate reads none (`outside_workspaces`).
 */
function placeWith(host: ShellPlace['host'], files: Record<string, string>): ShellPlace {
  const byPath = new Map(
    Object.entries(files).map(([rel, text]) => [resolve(root, rel).toLowerCase(), text]),
  );
  const inside = (p: string) => resolve(p).toLowerCase().startsWith(root.toLowerCase());
  return {
    cwd: root,
    host,
    inWorkspace: async (p) => inside(p),
    leadsTo: async () => null,
    readSource: async (p) => {
      if (!inside(p)) return { kind: 'unread', why: 'outside_workspaces' };
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

  it('sh: after `source`, which only bash has, the folder is not known: what follows asks', async () => {
    // env.sh stays where it is: in bash, cleanup.sh runs from the starting
    // folder; in dash, `source` does not exist. The text cannot say which.
    const command = 'source ./env.sh; ./cleanup.sh';
    const reasons = await judge(
      command,
      placeWith('posix', { 'env.sh': 'echo ready\n', 'cleanup.sh': HARMLESS.sh }),
    );
    expect(reasons).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: [command],
        unread: [{ source: './cleanup.sh', why: 'decided_at_run_time' }],
      },
    ]);
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
    // So does a job, a thread job, a parallel ForEach-Object, a remote command.
    for (const run of [
      'Start-Job { Set-Location sub }\n.\\cleanup.ps1\n',
      'Start-ThreadJob { Set-Location sub }\n.\\cleanup.ps1\n',
      '1..2 | ForEach-Object -Parallel { Set-Location sub }\n.\\cleanup.ps1\n',
      'Invoke-Command -ComputerName srv { Set-Location sub }\n.\\cleanup.ps1\n',
    ]) {
      expect(
        await kinds('powershell -File run.ps1', placeWith('windows', { ...files, 'run.ps1': run })),
        run,
      ).toEqual([]);
    }
    // A block the call operator runs once, in the runspace, moves it.
    expect(
      await kinds(
        'powershell -File run.ps1',
        placeWith('windows', {
          ...files,
          'run.ps1': '& { Set-Location sub }\n.\\cleanup.ps1\n',
        }),
      ),
    ).toEqual(['delete_files']);
    // A plain ForEach-Object runs its block in the runspace, any number of
    // times, none included: both cleanup.ps1 are read, the one in sub deletes.
    expect(
      await kinds(
        'powershell -File run.ps1',
        placeWith('windows', {
          ...files,
          'run.ps1': '1..2 | ForEach-Object { Set-Location sub }\n.\\cleanup.ps1\n',
        }),
      ),
    ).toEqual(['delete_files']);
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
      // cmd also looks for `curl` in the folder above the workspace, which
      // the gate cannot look into: it asks (pass 4).
      const lookedUp =
        host === 'windows'
          ? [
              {
                category: 'inline_code',
                state: 'ask',
                details: [command],
                unread: [{ source: 'curl', why: 'decided_at_run_time' }],
              },
            ]
          : [];
      expect(await judge(command, placeWith(host, files)), command).toEqual([
        download(command),
        ...lookedUp,
      ]);
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

describe('past its && chain, a move may not have been made: the files of every folder the line may be in are read (#717, Nodal review passes 1 and 3) @cap:executer-une-commande/moteur', () => {
  // decoy/cleanup.sh is not there; the starting folder's deletes: it is read.
  it.each([
    'false && cd decoy; ./cleanup.sh',
    'if false; then cd decoy; fi; ./cleanup.sh',
    'for i in ; do cd decoy; done; ./cleanup.sh',
    // the move runs, but may fail
    'cd nonexistent; ./cleanup.sh',
    'mkdir out; cd out; ./cleanup.sh',
  ])('%s reads the starting folder’s cleanup.sh', async (command) => {
    expect(await kinds(command, placeWith('posix', { 'cleanup.sh': DELETE_HERE.sh }))).toEqual([
      'delete_files',
    ]);
  });

  it('the folder moved into too', async () => {
    const command = 'mkdir out && cd out; ./gen.sh';
    expect(
      await kinds(
        command,
        placeWith('posix', { 'gen.sh': HARMLESS.sh, 'out/gen.sh': DELETE_HERE.sh }),
      ),
    ).toEqual(['delete_files']);
  });

  it('a file in no folder of the line runs nothing, as in the starting folder', async () => {
    expect(await judge('./cleanup.sh', placeWith('posix', {}))).toEqual([]);
    expect(await judge('mkdir out; cd out; ./gen.sh', placeWith('posix', {}))).toEqual([]);
    expect(await judge('cd sub; ./deploy.sh', placeWith('posix', {}))).toEqual([]);
  });

  it("a script's move, on an earlier line of it, is a move too", async () => {
    // prepare.bat's `cd sub` may fail: the starting folder's cleanup.bat may run
    expect(
      await kinds(
        'prepare.bat',
        placeWith('windows', {
          'prepare.bat': 'cd sub\r\ncall cleanup.bat\r\n',
          'cleanup.bat': DELETE_HERE.bat,
        }),
      ),
    ).toEqual(['delete_files']);
  });

  it('cmd: a move on the right of && or in an if body', async () => {
    for (const command of [
      'ver && cd decoy & cleanup.bat',
      'if exist a (cd decoy) & cleanup.bat',
    ]) {
      // decoy's cleanup.bat deletes, the starting folder's does not: both are read
      expect(
        await kinds(
          command,
          placeWith('windows', {
            'cleanup.bat': HARMLESS.bat,
            'decoy/cleanup.bat': DELETE_HERE.bat,
          }),
        ),
        command,
      ).toEqual(['delete_files']);
    }
  });
});

describe('a move joined by && to what follows is made for it (#717, Nodal review) @cap:executer-une-commande/moteur', () => {
  it('mkdir out && cd out && ./gen.sh reads out/gen.sh only', async () => {
    const command = 'mkdir out && cd out && ./gen.sh';
    expect(
      await judge(
        command,
        placeWith('posix', { 'out/gen.sh': HARMLESS.sh, 'gen.sh': DELETE_HERE.sh }),
      ),
    ).toEqual([]);
    expect(await kinds(command, placeWith('posix', { 'out/gen.sh': DELETE_HERE.sh }))).toEqual([
      'delete_files',
    ]);
  });

  it('mkdir -p build && cd build && cmake .. && make, and a download there, ask nothing', async () => {
    for (const command of [
      'mkdir -p build && cd build && cmake .. && make',
      'mkdir -p build && cd build && curl -o a.zip https://x/a',
      // joined by &&, it runs only if the cd succeeded: never from the starting folder
      'cd sub && curl -o ../evil.zip https://x/a',
    ])
      expect(await judge(command, placeWith('posix', {})), command).toEqual([]);
  });
});

describe('a script named without its extension is the script the shell finds (#717, Nodal review pass 1) @cap:executer-une-commande/moteur', () => {
  it('cmd: a bare name or a path that is a batch file of the folder is read, and leaves the line where it ends', async () => {
    for (const command of [
      'prepare & cleanup.bat',
      'call prepare & cleanup.bat',
      '.\\prepare & cleanup.bat',
    ]) {
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
    }
    // what the batch file does is judged too, read as cmd reads it (an `if`
    // without brackets runs its command only in cmd's reading)
    expect(
      await kinds(
        'prepare',
        placeWith('windows', { 'prepare.cmd': 'if exist a del /q important.txt\r\n' }),
      ),
    ).toEqual(['delete_files']);
  });

  it('a batch file found that may not run: both folders; a program: the one the line is in', async () => {
    const files = {
      'prepare.bat': '@echo off\r\ncd sub\r\n',
      'cleanup.bat': HARMLESS.bat,
      'sub/cleanup.bat': DELETE_HERE.bat,
    };
    expect(await kinds('ver && prepare & cleanup.bat', placeWith('windows', files))).toEqual([
      'delete_files',
    ]);
    expect(await judge('ver && npm test & cleanup.bat', placeWith('windows', files))).toEqual([]);
  });

  it('a folder the gate cannot look into: what the word is, and the folder after it, are not known', async () => {
    const place = placeWith('windows', { 'cleanup.bat': HARMLESS.bat });
    expect(
      await kinds('prepare & cleanup.bat', {
        ...place,
        readSource: async (p) =>
          /prepare\.\w+$/i.test(p)
            ? { kind: 'unread', why: 'outside_workspaces' }
            : place.readSource(p),
      }),
    ).toEqual(['inline_code']);
  });

  it('cmd: an .exe of the same name comes first; a name not in the folder is a program', async () => {
    const files = {
      'prepare.bat': '@echo off\r\ncd sub\r\n',
      'cleanup.bat': DELETE_HERE.bat,
      'sub/cleanup.bat': HARMLESS.bat,
    };
    expect(
      await kinds('prepare & cleanup.bat', {
        ...placeWith('windows', files),
        readSource: async (p) =>
          /prepare\.exe$/i.test(p)
            ? { kind: 'executable' }
            : placeWith('windows', files).readSource(p),
      }),
    ).toEqual(['delete_files']);
    // npm is no file of the folder: a program from the PATH, nothing asked
    expect(
      await judge('npm test & cleanup.bat', placeWith('windows', { 'cleanup.bat': HARMLESS.bat })),
    ).toEqual([]);
  });

  it('PowerShell: a path without .ps1 is the .ps1 of the folder', async () => {
    const files = {
      'env.ps1': 'Set-Location sub\n',
      'cleanup.ps1': 'Get-Date\n',
      'sub/cleanup.ps1': 'Remove-Item -Recurse build\n',
    };
    expect(
      await kinds(
        'powershell -File run.ps1',
        placeWith('windows', { ...files, 'run.ps1': '.\\env\n.\\cleanup.ps1\n' }),
      ),
    ).toEqual(['delete_files']);
    const download = 'powershell -File run.ps1';
    expect(
      await judge(
        download,
        placeWith('windows', {
          'env.ps1': 'Set-Location ..\n',
          'run.ps1': '.\\env\niwr https://x/a -OutFile a.zip\n',
        }),
      ),
    ).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [download],
        outside: [{ command: download, places: ['a.zip'] }],
        found: [{ source: 'run.ps1', line: 2, text: 'iwr https://x/a -OutFile a.zip' }],
      },
    ]);
  });
});

describe('a bare name not found after a move is a program of the PATH (#717, Nodal review pass 2) @cap:executer-une-commande/moteur', () => {
  it.each([
    ['cd sub && npm.cmd test', 'windows'],
    ['cd sub & npm.cmd test', 'windows'],
    ['cd out && run.bat', 'windows'],
    ['cd sub; deploy.sh', 'posix'],
  ] as const)('%s asks nothing', async (command, host) => {
    expect(await judge(command, placeWith(host, {}))).toEqual([]);
  });
});

describe('a cd may fail whatever the disk holds when the gate judges: every folder the line may be in is judged (#723, Nodal review pass 3) @cap:executer-une-commande/moteur', () => {
  const downloadOutside = (command: string, place: string) => [
    {
      category: 'download',
      state: 'ask',
      details: [command],
      outside: [{ command, places: [place] }],
    },
  ];
  const unknownScript = (command: string, source: string) => [
    {
      category: 'inline_code',
      state: 'ask',
      details: [command],
      unread: [{ source, why: 'decided_at_run_time' }],
    },
  ];

  it('sh: past `cd sub;`, a download and a script are judged from the starting folder too', async () => {
    // From the starting folder, ../evil.zip and ../cleanup.sh leave the workspace.
    // sub there when the gate judges, removed by the line before its cd
    for (const [command, files] of [
      ['cd sub; curl -o ../evil.zip https://x/a', {}],
      ['rm -rf sub; cd sub; curl -o ../evil.zip https://x/a', { 'sub/a.txt': 'a' }],
    ] as const)
      expect(await judge(command, placeWith('posix', files)), command).toContainEqual(
        downloadOutside(command, '../evil.zip')[0],
      );
    for (const command of ['cd sub; ../cleanup.sh', 'cd sub/../other; ../cleanup.sh'])
      expect(
        await judge(command, placeWith('posix', { 'cleanup.sh': HARMLESS.sh, 'other/x': 'x' })),
        command,
      ).toEqual(unknownScript(command, '../cleanup.sh'));
  });

  it("cmd: #723's line, the starting folder's prepare.bat read after a cd that may fail", async () => {
    // prepare.bat, in the starting folder, does `cd ..` and deletes.
    const command = 'cd missing & prepare & curl -o a.zip https://x/a';
    const files = { 'prepare.bat': '@echo off\r\ndel /q important.txt\r\ncd ..\r\n' };
    expect(await judge(command, placeWith('windows', files))).toEqual([
      ...downloadOutside(command, 'a.zip'),
      {
        category: 'delete_files',
        state: 'ask',
        details: [command],
        found: [{ source: 'prepare.bat', line: 2, text: 'del /q important.txt' }],
      },
      // `curl`, looked for in the folder above the workspace (pass 4)
      {
        category: 'inline_code',
        state: 'ask',
        details: [command],
        unread: [{ source: 'curl', why: 'decided_at_run_time' }],
      },
    ]);
  });

  it("PowerShell: `cd missing; .\\run` reads the starting folder's run.ps1", async () => {
    const command = 'powershell -Command "cd missing; .\\run"';
    expect(
      await kinds(command, placeWith('windows', { 'run.ps1': 'Remove-Item -Recurse build\n' })),
    ).toEqual(['delete_files']);
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

  // `cd ..` may succeed: the prepare.bat of the folder above the workspace,
  // which the gate cannot read, is the one that runs; whether the workspace
  // holds a harmless one or none changes nothing.
  it.each([
    ['a harmless prepare.bat in the workspace', { 'prepare.bat': HARMLESS.bat }],
    ['none', {}],
  ])(
    'a word that may be a script, in a folder the gate cannot look into, asks (pass 4): %s',
    async (_, files) => {
      const command = 'cd .. & prepare';
      expect(await judge(command, placeWith('windows', files))).toEqual([
        {
          category: 'inline_code',
          state: 'ask',
          details: [command],
          unread: [{ source: 'prepare', why: 'decided_at_run_time' }],
        },
      ]);
    },
  );

  it('in a folder not known, a word that may be a script of it asks', async () => {
    // `call x.bat`, not in the folder, comes from the PATH: where it leaves the line is not known
    const command = 'call x.bat & prepare & cleanup.bat';
    expect(await judge(command, placeWith('windows', {}))).toEqual([
      {
        category: 'inline_code',
        state: 'ask',
        details: [command],
        unread: [
          { source: 'prepare', why: 'decided_at_run_time' },
          { source: 'cleanup.bat', why: 'decided_at_run_time' },
        ],
      },
    ]);
  });

  it('a line may be in at most MAX_FOLDERS folders: past that, not known', async () => {
    // each cd past its chain doubles the folders: three make eight, four sixteen
    const cds = (n: number) => Array.from({ length: n }, (_, i) => `cd d${i}`).join('; ');
    const four = `${cds(4)}; ./x.sh`;
    expect(await judge(four, placeWith('posix', { 'x.sh': HARMLESS.sh }))).toEqual(
      unknownScript(four, './x.sh'),
    );
    expect(await judge(`${cds(3)}; ./x.sh`, placeWith('posix', { 'x.sh': HARMLESS.sh }))).toEqual(
      [],
    );
  });
});

describe('cmd: the & of a handle duplication separates nothing (#717, Nodal review pass 5) @cap:executer-une-commande/moteur', () => {
  // A 1.bat and a 2.bat that delete, in the folder the line starts in: a
  // redirection read as a command would look `1` or `2` up, find them, read them.
  const decoys = { '1.bat': DELETE_HERE.bat, '2.bat': DELETE_HERE.bat, 'x.bat': HARMLESS.bat };

  it.each([
    'echo done >NUL 2>&1',
    'x.bat 2>&1',
    'curl -o a.jpg https://x/a 2>&1',
    '1>&2 echo hi',
    'echo hi >&2 & x.bat',
  ])('%s reads no decoy', async (command) => {
    expect(await judge(command, placeWith('windows', decoys))).toEqual([]);
  });

  it('cd .. & echo done >NUL 2>&1 asks nothing', async () => {
    // no `1` looked for in the folder above the workspace, which cannot be looked at
    expect(await judge('cd .. & echo done >NUL 2>&1', placeWith('windows', {}))).toEqual([]);
  });
});
