// folder-moves.test.ts — which commands of a line move the folder the rest of
// it runs from (#717).
//
// Only a command of the line's own shell process moves it. A child process
// (`cmd /c`, `bash -c`, a `( … )` subshell, a side of a pipe…) keeps its moves:
// they reach its own later commands, never the line's. A script run in the
// line's own process (cmd's batch files, PowerShell's `.ps1`, what sh's `.`
// and `source` read) leaves the line where its body ends, which only the gate
// reads (`{ script }`). Both readings of a line's folders go through it: the
// sources it runs (`programSources`) and where its downloads land
// (`downloadWrites`).

import { describe, it, expect } from 'vitest';
import { downloadWrites, programSources, type FolderMove } from '..';

const SAVE: FolderMove = { save: true };
const RESTORE: FolderMove = { restore: true };
const script = (path: string): FolderMove => ({ script: path });
/**
 * Past the `&&` chain of the `cd` at `at`: the gate looks whether the folder
 * it entered is there; a `cd` into a missing one fails (#723).
 */
const checked = (at: number): FolderMove => ({ unsure: at, ran: true });
/**
 * A word cmd may resolve to a batch file of the folder (`cmd`, `curl`): the
 * gate looks there (Nodal review of PR #721, P2).
 */
const looked = (path: string): FolderMove => ({
  script: path,
  extensions: ['.com', '.exe', '.bat', '.cmd'],
});

type Host = 'windows' | 'posix';
type Reader = 'sh' | 'cmd' | 'powershell';

/** The folder moves of a line, and how many of them come before each file it runs. */
function read(
  cmd: string,
  host: Host,
  reader?: Reader,
): { dirs: FolderMove[]; after: Record<string, number> } {
  const { dirs, sources } = programSources(cmd, {
    direct: true,
    host,
    ...(reader ? { reader } : {}),
  });
  const after: Record<string, number> = {};
  for (const s of sources) if (s.kind === 'file' && s.path !== null) after[s.path] = s.after;
  return { dirs, after };
}

/** Where a line's downloads land: its folder moves, and how many come before each target. */
function writes(cmd: string, host: Host, reader?: Reader) {
  const { dirs, targets } = downloadWrites(cmd, host, reader);
  return { dirs, after: targets.map((t) => t.after) };
}

/**
 * Where the line is after the first `upTo` moves, written from the folder it
 * starts in (`''`): the folders entered joined with `/`, a script run in its
 * process as `|name` (only the gate reads where it ends), null when not known.
 * The gate's own reading of these moves is `basesOf` (packages/tools); a word
 * only looked for is taken here for the program it is when no file is there.
 */
function folderAt(dirs: readonly FolderMove[], upTo: number | undefined): string | null {
  const bases: Array<string | null> = [''];
  const kept: Array<string | null> = [];
  let base: string | null = '';
  for (const m of dirs.slice(0, upTo)) {
    if (m === null) base = null;
    else if (typeof m === 'string') base = base === null ? null : base === '' ? m : `${base}/${m}`;
    else if ('script' in m) {
      if (m.extensions === undefined) base = base === null ? null : `${base}|${m.script}`;
    } else if ('unsure' in m) {
      // a cd that ran is taken here into a folder that is there (only the gate looks)
      if (m.ran !== true && bases[m.unsure] !== bases[m.unsure + 1]) base = null;
    } else if ('save' in m) kept.push(base);
    else base = kept.length > 0 ? (kept.pop() ?? null) : null;
    bases.push(base);
  }
  return base;
}

describe('a folder move made in a child process stays there (#717) @cap:executer-une-commande/moteur', () => {
  it('the issue lines, as the gate receives them', () => {
    expect(read('cmd /c "cd decoy" & cleanup.bat', 'windows')).toEqual({
      dirs: [looked('cmd'), SAVE, 'decoy', checked(2), RESTORE, script('cleanup.bat')],
      after: { cmd: 0, 'cleanup.bat': 5 },
    });
    expect(read('bash -c "cd decoy" && ./cleanup.sh', 'posix')).toEqual({
      dirs: [SAVE, 'decoy', checked(1), RESTORE],
      after: { './cleanup.sh': 4 },
    });
    expect(read('(cd decoy) && ./cleanup.sh', 'posix')).toEqual({
      dirs: [SAVE, 'decoy', checked(1), RESTORE],
      after: { './cleanup.sh': 4 },
    });
  });

  it.each([
    // the shells a line starts
    ['powershell -Command "cd decoy" & x.bat', 'windows', 'x.bat'],
    ['pwsh -c "Set-Location decoy" & x.bat', 'windows', 'x.bat'],
    ['cmd /c "pushd decoy" & x.bat', 'windows', 'x.bat'],
    ['sh -c "cd decoy"; ./x.sh', 'posix', './x.sh'],
    // programs that run another one in a process of its own
    ['sudo sh -c "cd decoy"; ./x.sh', 'posix', './x.sh'],
    ['env cd decoy; ./x.sh', 'posix', './x.sh'],
    ['nohup sh -c "cd decoy"; ./x.sh', 'posix', './x.sh'],
    ['timeout 5 sh -c "cd decoy"; ./x.sh', 'posix', './x.sh'],
    ['xargs sh -c "cd decoy" < list; ./x.sh', 'posix', './x.sh'],
    ['find . -exec sh -c "cd decoy" ; ; ./x.sh', 'posix', './x.sh'],
    ['start /b cmd /c "cd decoy" & x.bat', 'windows', 'x.bat'],
    // a module named like a folder change runs in python's process
    ['python -m cd decoy; ./x.sh', 'posix', './x.sh'],
    // sh: a subshell, a side of a pipe, the background, a substitution, a here-document
    ['(cd decoy); ./x.sh', 'posix', './x.sh'],
    ['cd decoy | cat; ./x.sh', 'posix', './x.sh'],
    ['cat a | cd decoy; ./x.sh', 'posix', './x.sh'],
    ['cd decoy & ./x.sh', 'posix', './x.sh'],
    // `&` sends the whole list to the background, not its last command
    ['cd decoy && true & ./x.sh', 'posix', './x.sh'],
    ['{ cd decoy; } | cat; ./x.sh', 'posix', './x.sh'],
    ['echo $(cd decoy); ./x.sh', 'posix', './x.sh'],
    ['echo "$(cd decoy)"; ./x.sh', 'posix', './x.sh'],
    ['echo `cd decoy`; ./x.sh', 'posix', './x.sh'],
    ['diff <(cd decoy) a; ./x.sh', 'posix', './x.sh'],
    ['bash <<EOF\ncd decoy\nEOF\n./x.sh', 'posix', './x.sh'],
    // cmd: a side of a pipe, and a parenthesis that is only text
    ['cd decoy | more & x.bat', 'windows', 'x.bat'],
    ['echo (cd decoy) & x.bat', 'windows', 'x.bat'],
  ] as const)('%s', (cmd, host, file) => {
    const { dirs, after } = read(cmd, host);
    expect(after[file]).toBeDefined();
    // the folder the line started in, known
    expect(folderAt(dirs, after[file])).toBe('');
  });

  it('PowerShell: a job sent to the background', () => {
    expect(read('cd decoy &\n.\\x.ps1', 'windows', 'powershell')).toEqual({
      dirs: [SAVE, 'decoy', checked(1), RESTORE, script('.\\x.ps1')],
      after: { '.\\x.ps1': 4 },
    });
  });

  it.each([
    'Start-Job { cd decoy }; .\\x.ps1',
    'Start-Job -ScriptBlock { Set-Location decoy }; .\\x.ps1',
    'sajb { cd decoy }; .\\x.ps1',
    '$j = Start-Job { cd decoy }; .\\x.ps1',
    '$j=Start-Job { cd decoy }; .\\x.ps1',
    'Start-ThreadJob { cd decoy }; .\\x.ps1',
    '1..3 | ForEach-Object -Parallel { cd decoy }; .\\x.ps1',
    '1..3 | % -Parallel { cd decoy }; .\\x.ps1',
    '1..3 | foreach -Pa { cd decoy }; .\\x.ps1',
    '1..3 | ForEach-Object -UseNewRunspace { cd decoy }; .\\x.ps1',
    '1..3 | % -UseNew { cd decoy }; .\\x.ps1',
    'Invoke-Command -ComputerName srv { cd decoy }; .\\x.ps1',
    'icm -Session $s -ScriptBlock { cd decoy }; .\\x.ps1',
    'Invoke-Command -AsJob { cd decoy }; .\\x.ps1',
  ])('PowerShell: a script block run in another runspace or process: %s', (cmd) => {
    const { dirs, after } = read(cmd, 'windows', 'powershell');
    expect(after['.\\x.ps1']).toBeDefined();
    // the line stays where it was, known: nothing of the block is in force
    expect(folderAt(dirs, after['.\\x.ps1'])).toBe('');
  });

  it("a child's moves still reach its own later commands", () => {
    expect(read('bash -c "cd sub && ./x.sh" && ./y.sh', 'posix')).toEqual({
      dirs: [SAVE, 'sub', checked(1), RESTORE],
      after: { './x.sh': 2, './y.sh': 4 },
    });
    expect(read('(cd sub && ./x.sh) && ./y.sh', 'posix')).toEqual({
      dirs: [SAVE, 'sub', checked(1), RESTORE],
      after: { './x.sh': 2, './y.sh': 4 },
    });
    // past `&`, cmd's next command: whether `sub` is there, the gate looks
    expect(read('cmd /c "cd sub & x.bat" & y.bat', 'windows')).toEqual({
      dirs: [looked('cmd'), SAVE, 'sub', checked(2), script('x.bat'), RESTORE, script('y.bat')],
      after: { cmd: 0, 'x.bat': 4, 'y.bat': 6 },
    });
  });
});

describe("a folder move made in the line's own process moves it (#717) @cap:executer-une-commande/moteur", () => {
  it.each([
    ['call cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['(cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['cd decoy && x.bat', 'windows', 'x.bat', undefined],
    ['{ cd decoy; } && ./x.sh', 'posix', './x.sh', undefined],
    ['eval "cd decoy"; ./x.sh', 'posix', './x.sh', undefined],
    ['command cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    // the head of a list runs whenever the line reaches it
    ['cd decoy || exit 1; ./x.sh', 'posix', './x.sh', undefined],
    ['cd decoy && ./x.sh', 'posix', './x.sh', undefined],
    ['if cd decoy; then echo in; fi; ./x.sh', 'posix', './x.sh', undefined],
    // past a list, or a compound command, the next one starts again
    ['true && echo; cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['if x; then echo; fi; cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['ver && echo & cd decoy & x.bat', 'windows', 'x.bat', undefined],
    // PowerShell: a block, a pipeline, the call operator and iex run in its runspace
    ['(cd decoy); .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['cd decoy | Out-Null; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ["iex 'cd decoy'; .\\x.ps1", 'windows', '.\\x.ps1', 'powershell'],
    ['& { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['Invoke-Command { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['Invoke-Command -NoNewScope { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['try { cd decoy } catch { }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
  ] as const)('%s', (cmd, host, file, reader) => {
    const { dirs, after } = read(cmd, host, reader);
    expect(after[file]).toBeDefined();
    expect(folderAt(dirs, after[file])).toBe('decoy');
  });

  it.each([
    // sh: the right of `&&` / `||`, an if, while, until, for or case body, a function
    ['false && cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['true || cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['true && (cd sub; ./a.sh) && cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['if false; then cd decoy; fi; ./x.sh', 'posix', './x.sh', undefined],
    ['if true; then echo; else cd decoy; fi; ./x.sh', 'posix', './x.sh', undefined],
    ['while false; do cd decoy; done; ./x.sh', 'posix', './x.sh', undefined],
    ['until true; do cd decoy; done; ./x.sh', 'posix', './x.sh', undefined],
    ['for i in ; do cd decoy; done; ./x.sh', 'posix', './x.sh', undefined],
    ['case $x in a) cd decoy;; esac; ./x.sh', 'posix', './x.sh', undefined],
    ['{ false && cd decoy; }; ./x.sh', 'posix', './x.sh', undefined],
    ['f() { cd decoy; }; ./x.sh', 'posix', './x.sh', undefined],
    ['function f { cd decoy; }; ./x.sh', 'posix', './x.sh', undefined],
    ['false && . ./env.sh; ./x.sh', 'posix', './x.sh', undefined],
    // cmd: the right of `&&` / `||`, an if, else or for command
    ['ver && cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['ver || cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['if exist a cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['if exist a (cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['if exist a (echo) else (cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['for %d in (a) do cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['for %d in (a) do (cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['ver && prepare.bat & x.bat', 'windows', 'x.bat', undefined],
    // PowerShell: a block that may run any number of times, the right of `&&` / `||`
    ['if ($x) { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['if ($x) { } else { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['foreach ($d in $a) { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['while ($x) { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['Get-Item a | ForEach-Object { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['1..3 | % -Process { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['try { } catch { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['function f { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['{ cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['Test-Path a && cd decoy; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    // past a group, the list it is part of goes on
    ['Test-Path a && (echo) | cd decoy; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
  ] as const)(
    'a move that may not happen leaves the folder unknown: %s',
    (cmd, host, file, reader) => {
      const { dirs, after } = read(cmd, host, reader);
      expect(after[file]).toBeDefined();
      expect(folderAt(dirs, after[file])).toBeNull();
    },
  );

  it('sh: what only bash runs in its own process leaves the folder unknown', () => {
    // The posix host's /bin/sh is dash on Debian and Ubuntu, bash elsewhere:
    // dash has no `source` and no `builtin`, and its `time` is a program.
    // Whether they ran what they name in the line's process, the text does
    // not say. `.` is POSIX: certain.
    expect(read('source env.sh && ./x.sh', 'posix')).toEqual({
      dirs: [null],
      after: { 'env.sh': 0, './x.sh': 1 },
    });
    expect(read('time cd decoy; ./x.sh', 'posix')).toEqual({
      dirs: [null],
      after: { './x.sh': 1 },
    });
    expect(read('builtin cd decoy; ./x.sh', 'posix')).toEqual({
      dirs: [null],
      after: { './x.sh': 1 },
    });
    // what they start in a process of its own stays there
    expect(read('time bash -c "cd decoy"; ./x.sh', 'posix')).toEqual({
      dirs: [SAVE, 'decoy', checked(1), RESTORE],
      after: { './x.sh': 4 },
    });
  });

  it('a PowerShell subexpression read twice, when it is not quoted, leaves the folder unknown', () => {
    // `$(…)` runs in PowerShell's runspace; the scan reads its commands and so
    // does the reading of substitutions: its move cannot be counted once.
    const { dirs, after } = read('echo $(cd decoy); .\\x.ps1', 'windows', 'powershell');
    expect(folderAt(dirs, after['.\\x.ps1'])).toBeNull();
  });
});

describe('a move that may not run is made for what follows it through && alone (#717, Nodal review) @cap:executer-une-commande/moteur', () => {
  // What follows a move through `&&` alone runs only if the move ran.
  it.each([
    ['mkdir out && cd out && ./gen.sh', 'posix', './gen.sh', undefined, 'out'],
    [
      'mkdir -p build && cd build && cmake .. && make && ./run.sh',
      'posix',
      './run.sh',
      undefined,
      'build',
    ],
    ['false && cd decoy && ./a.sh; ./x.sh', 'posix', './a.sh', undefined, 'decoy'],
    ['false && cd decoy && (./a.sh; ./b.sh); ./x.sh', 'posix', './b.sh', undefined, 'decoy'],
    ['false && cd decoy && ./a.sh | ./b.sh', 'posix', './b.sh', undefined, 'decoy'],
    // past a group of the chain, the chain goes on
    ['false && cd decoy && (true; true) && ./a.sh', 'posix', './a.sh', undefined, 'decoy'],
    // a move a child may not make is undone with the child, and leaves nothing unknown
    ['bash -c "false && cd sub"; ./x.sh', 'posix', './x.sh', undefined, ''],
    ['if x; then cd out && ./a.sh; fi; ./x.sh', 'posix', './a.sh', undefined, 'out'],
    ['ver && cd out && x.bat', 'windows', 'x.bat', undefined, 'out'],
    ['if exist a (cd out && x.bat) & y.bat', 'windows', 'x.bat', undefined, 'out'],
    ['Test-Path a && cd out && .\\x.ps1', 'windows', '.\\x.ps1', 'powershell', 'out'],
  ] as const)('%s: %s runs in the folder moved into', (cmd, host, file, reader, folder) => {
    const { dirs, after } = read(cmd, host, reader);
    expect(after[file]).toBeDefined();
    expect(folderAt(dirs, after[file])).toBe(folder);
  });

  // Past that chain, or reached otherwise, the folder is not known.
  it.each([
    ['mkdir -p build && cd build && make; ./x.sh', 'posix', './x.sh', undefined],
    ['false && cd decoy && ./a.sh; ./x.sh', 'posix', './x.sh', undefined],
    ['false && cd decoy && (./a.sh; ./b.sh); ./x.sh', 'posix', './x.sh', undefined],
    ['false && cd decoy\n./x.sh', 'posix', './x.sh', undefined],
    // `||` runs what follows when what came before failed, or not at all
    ['false && cd decoy || ./x.sh', 'posix', './x.sh', undefined],
    // right after `||`, a move is skipped exactly when the list succeeded: the `&&` after it then runs anyway
    ['true || cd decoy && ./x.sh', 'posix', './x.sh', undefined],
    ['if x; then cd out && ./a.sh; fi; ./x.sh', 'posix', './x.sh', undefined],
    ['if false; then cd decoy; fi && ./x.sh', 'posix', './x.sh', undefined],
    ['ver && cd out & x.bat', 'windows', 'x.bat', undefined],
    // the `&&` after cmd's `if` runs whether its command did or not
    ['if exist a cd out && x.bat', 'windows', 'x.bat', undefined],
    ['if exist a (cd out) && x.bat', 'windows', 'x.bat', undefined],
    ['Test-Path a && cd out; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
  ] as const)('%s: %s, past it, does not know', (cmd, host, file, reader) => {
    const { dirs, after } = read(cmd, host, reader);
    expect(after[file]).toBeDefined();
    expect(folderAt(dirs, after[file])).toBeNull();
  });

  it('a download joined to the move by && lands where it moved', () => {
    const { dirs, after } = writes(
      'mkdir -p build && cd build && curl -o a.zip https://x/a',
      'posix',
    );
    expect(folderAt(dirs, after[0] ?? undefined)).toBe('build');
  });
});

describe("a script run in the line's own process leaves it where it ends (#717) @cap:executer-une-commande/moteur", () => {
  it('cmd: a batch file run directly or with call', () => {
    expect(read('setup.bat & cleanup.bat', 'windows')).toEqual({
      dirs: [script('setup.bat'), script('cleanup.bat')],
      after: { 'setup.bat': 0, 'cleanup.bat': 1 },
    });
    // on the right of `&&`, a script may not run: where it leaves the line is not known
    expect(read('setup.bat && cleanup.bat', 'windows')).toEqual({
      dirs: [script('setup.bat'), script('cleanup.bat'), { unsure: 1 }],
      after: { 'setup.bat': 0, 'cleanup.bat': 1 },
    });
    expect(read('call setup.cmd & cleanup.bat', 'windows')).toEqual({
      dirs: [script('setup.cmd'), script('cleanup.bat')],
      after: { 'setup.cmd': 0, 'cleanup.bat': 1 },
    });
  });

  it('cmd: a name without its extension may be a batch file of the folder: the gate looks', () => {
    const probe = (path: string): FolderMove => ({
      script: path,
      extensions: ['.com', '.exe', '.bat', '.cmd'],
    });
    const { dirs, sources } = programSources('prepare & cleanup.bat', {
      direct: true,
      host: 'windows',
    });
    expect(dirs).toEqual([probe('prepare'), script('cleanup.bat')]);
    expect(sources[0]).toEqual({
      kind: 'file',
      path: 'prepare',
      language: null,
      after: 0,
      searched: true,
      executed: true,
      extensions: ['.com', '.exe', '.bat', '.cmd'],
    });
    expect(read('scripts\\prepare & x.bat', 'windows').dirs).toEqual([
      probe('scripts\\prepare'),
      script('x.bat'),
    ]);
    // cmd's own commands are never looked for
    expect(read('echo hi & cd sub & x.bat', 'windows').dirs).toEqual([
      'sub',
      checked(0),
      script('x.bat'),
    ]);
  });

  it('PowerShell: a path without its extension may be a .ps1; a bare name is not looked for in the folder', () => {
    expect(read('.\\env; .\\x.ps1', 'windows', 'powershell')).toEqual({
      dirs: [{ script: '.\\env', extensions: ['.ps1'] }, script('.\\x.ps1')],
      after: { '.\\env': 0, '.\\x.ps1': 1 },
    });
    expect(read('env; .\\x.ps1', 'windows', 'powershell').dirs).toEqual([script('.\\x.ps1')]);
    // sh runs no file of the folder in its own process but what `.` reads
    expect(read('prepare; ./x.sh', 'posix').dirs).toEqual([]);
  });

  it('sh: what `.` reads; a script run directly is a child', () => {
    expect(read('. ./env.sh; ./x.sh', 'posix')).toEqual({
      dirs: [script('./env.sh')],
      after: { './env.sh': 0, './x.sh': 1 },
    });
    expect(read('./env.sh && ./x.sh', 'posix')).toEqual({
      dirs: [],
      after: { './env.sh': 0, './x.sh': 0 },
    });
    expect(read('bash env.sh && ./x.sh', 'posix')).toEqual({
      dirs: [],
      after: { 'env.sh': 0, './x.sh': 0 },
    });
  });

  it('PowerShell: a .ps1 run directly, dot-sourced or called keeps its location', () => {
    for (const cmd of [
      '.\\env.ps1; .\\x.ps1',
      '. .\\env.ps1; .\\x.ps1',
      '& .\\env.ps1; .\\x.ps1',
    ]) {
      expect(read(cmd, 'windows', 'powershell'), cmd).toEqual({
        dirs: [script('.\\env.ps1'), script('.\\x.ps1')],
        after: { '.\\env.ps1': 0, '.\\x.ps1': 1 },
      });
    }
  });

  it('a script run as a child moves nothing of the line', () => {
    expect(read('powershell -File env.ps1 & x.bat', 'windows').dirs).toEqual([
      looked('powershell'),
      script('x.bat'),
    ]);
    expect(read('env.ps1 & x.bat', 'windows').dirs).toEqual([script('x.bat')]);
    expect(read('cmd /c env.bat & x.bat', 'windows')).toEqual({
      dirs: [looked('cmd'), SAVE, script('env.bat'), RESTORE, script('x.bat')],
      after: { cmd: 0, 'env.bat': 2, 'x.bat': 4 },
    });
  });

  it('a script the text does not name leaves the folder unknown', () => {
    expect(read('call %SETUP% & x.bat', 'windows').dirs).toEqual([null, script('x.bat')]);
    expect(read('. "$ENV_FILE"; ./x.sh', 'posix').dirs).toEqual([null]);
    expect(read('& $setup; .\\x.ps1', 'windows', 'powershell').dirs).toEqual([
      null,
      script('.\\x.ps1'),
    ]);
  });

  it("cmd's setlocal keeps a batch file's moves inside it, in a batch file only", () => {
    expect(read('setlocal & cd sub & endlocal & x.bat', 'windows', 'cmd')).toEqual({
      dirs: [SAVE, 'sub', checked(1), RESTORE, script('x.bat')],
      after: { 'x.bat': 4 },
    });
    // On a command line, setlocal does nothing.
    expect(read('setlocal & cd sub & endlocal & x.bat', 'windows')).toEqual({
      dirs: ['sub', checked(0), script('x.bat')],
      after: { 'x.bat': 2 },
    });
  });
});

describe('a line whose shell is not known, read as both (#717) @cap:executer-une-commande/moteur', () => {
  it('where cmd and sh read a move differently, the folder after it is not known', () => {
    // a block in cmd, a subshell in sh
    expect(programSources('(cd decoy) && ./x.sh').dirs).toEqual([null]);
    // a batch file of cmd's own process, a program sh starts
    expect(programSources('prepare.bat && x.bat').dirs).toEqual([null, null]);
    // a name cmd looks for in the folder first, a program sh starts
    expect(programSources('cd sub && node build.js').dirs).toEqual(['sub', null, checked(0)]);
  });

  it('where they agree, the move is read', () => {
    expect(programSources('cd sub && ./build.sh').dirs).toEqual(['sub', checked(0)]);
    expect(programSources('bash.exe -c "cd sub" && ./build.sh').dirs).toEqual([
      SAVE,
      'sub',
      checked(1),
      RESTORE,
    ]);
  });
});

describe('where a download lands follows the same folder moves (#717) @cap:executer-une-commande/moteur', () => {
  it('a child process moves nothing of the line', () => {
    for (const [cmd, host] of [
      ['cmd /c "cd decoy" & curl -o a.zip https://x/a', 'windows'],
      ['cd decoy | more & curl -o a.zip https://x/a', 'windows'],
      ['bash -c "cd decoy" && curl -o a.zip https://x/a', 'posix'],
      ['(cd decoy) && curl -o a.zip https://x/a', 'posix'],
      ['cd decoy | cat; curl -o a.zip https://x/a', 'posix'],
    ] as const) {
      const { dirs, after } = writes(cmd, host);
      expect(folderAt(dirs, after[0] ?? undefined), cmd).toBe('');
      expect(dirs, cmd).toContain('decoy');
    }
  });

  it("read with PowerShell's grammar, `&` only starts the next command of the same process", () => {
    // `&` and `&&` are read as PowerShell's call operator before the next
    // command: in cmd and sh it is the line's own process all the same.
    expect(writes('cd a & cd b & curl -o z.zip https://x/a', 'windows')).toEqual({
      dirs: ['a', checked(0), 'b', checked(2), looked('curl')],
      after: [4],
    });
    // (`cd b`, on the right of `&&`, may not run: certain for its chain, not past it)
    expect(writes('cd a && cd b && curl -o z.zip https://x/a', 'posix')).toEqual({
      dirs: ['a', 'b', { unsure: 1 }, checked(0)],
      after: [2],
    });
  });

  it('a download inside a child is read from its folder', () => {
    expect(writes('bash -c "cd sub && curl -o a.zip https://x/a"', 'posix')).toEqual({
      dirs: [SAVE, 'sub', checked(1), RESTORE],
      after: [2],
    });
  });

  it("the line's own process moves it", () => {
    expect(writes('(cd sub) & curl -o a.zip https://x/a', 'windows')).toEqual({
      dirs: ['sub', checked(0), looked('curl')],
      after: [2],
    });
    expect(writes('{ cd sub; } && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: ['sub', checked(0)],
      after: [2],
    });
    expect(
      writes('cd sub | Out-Null; iwr https://x/a -OutFile a.zip', 'windows', 'powershell'),
    ).toEqual({ dirs: ['sub', checked(0)], after: [2] });
  });

  it("a script run in the line's process leaves the download where it ends", () => {
    expect(writes('setup.bat && curl -o a.zip https://x/a', 'windows')).toEqual({
      dirs: [script('setup.bat'), looked('curl'), { unsure: 1 }],
      after: [1],
    });
    expect(writes('. ./env.sh && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: [script('./env.sh')],
      after: [1],
    });
    // `source`: only bash has it; where the line is after it is not known
    expect(writes('source env.sh && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: [null],
      after: [1],
    });
    // a job's script block keeps its location to itself
    expect(
      writes('Start-Job { cd .. }; iwr https://x/a -OutFile a.zip', 'windows', 'powershell'),
    ).toEqual({ dirs: [SAVE, '..', { unsure: 1 }, RESTORE], after: [4] });
    expect(writes('.\\env.ps1; iwr https://x/a -OutFile a.zip', 'windows', 'powershell')).toEqual({
      dirs: [script('.\\env.ps1')],
      after: [1],
    });
    expect(writes('bash env.sh && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: [],
      after: [0],
    });
  });

  it('a name the shell may resolve to a script of the folder, and a move that may not happen', () => {
    expect(writes('prepare & curl -o a.zip https://x/a', 'windows')).toEqual({
      dirs: [looked('prepare'), looked('curl')],
      after: [1],
    });
    expect(writes('.\\env; iwr https://x/a -OutFile a.zip', 'windows', 'powershell')).toEqual({
      dirs: [{ script: '.\\env', extensions: ['.ps1'] }],
      after: [1],
    });
    expect(writes('false && cd .. ; curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: ['..', { unsure: 0 }],
      after: [2],
    });
  });

  it("a batch file's setlocal", () => {
    expect(
      writes('setlocal & cd sub & endlocal & curl -o a.zip https://x/a', 'windows', 'cmd'),
    ).toEqual({ dirs: [SAVE, 'sub', checked(1), RESTORE, looked('curl')], after: [4] });
  });
});
