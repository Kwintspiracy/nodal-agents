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
 * The moves among the first `upTo` that are still in force there: a move made
 * between a save and its restore is undone by the restore.
 */
function inForce(dirs: readonly FolderMove[], upTo: number | undefined): FolderMove[] {
  const levels: FolderMove[][] = [[]];
  for (const m of dirs.slice(0, upTo)) {
    if (JSON.stringify(m) === JSON.stringify(SAVE)) levels.push([]);
    else if (JSON.stringify(m) === JSON.stringify(RESTORE)) levels.pop();
    else levels[levels.length - 1]?.push(m);
  }
  return levels.flat();
}

describe('a folder move made in a child process stays there (#717) @cap:executer-une-commande/moteur', () => {
  it('the issue lines, as the gate receives them', () => {
    expect(read('cmd /c "cd decoy" & cleanup.bat', 'windows')).toEqual({
      dirs: [SAVE, 'decoy', RESTORE, script('cleanup.bat')],
      after: { 'cleanup.bat': 3 },
    });
    expect(read('bash -c "cd decoy" && ./cleanup.sh', 'posix')).toEqual({
      dirs: [SAVE, 'decoy', RESTORE],
      after: { './cleanup.sh': 3 },
    });
    expect(read('(cd decoy) && ./cleanup.sh', 'posix')).toEqual({
      dirs: [SAVE, 'decoy', RESTORE],
      after: { './cleanup.sh': 3 },
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
    expect(inForce(dirs, after[file])).not.toContain('decoy');
  });

  it('PowerShell: a job sent to the background', () => {
    expect(read('cd decoy &\n.\\x.ps1', 'windows', 'powershell')).toEqual({
      dirs: [SAVE, 'decoy', RESTORE, script('.\\x.ps1')],
      after: { '.\\x.ps1': 3 },
    });
  });

  it("a child's moves still reach its own later commands", () => {
    expect(read('bash -c "cd sub && ./x.sh" && ./y.sh', 'posix')).toEqual({
      dirs: [SAVE, 'sub', RESTORE],
      after: { './x.sh': 2, './y.sh': 3 },
    });
    expect(read('(cd sub && ./x.sh) && ./y.sh', 'posix')).toEqual({
      dirs: [SAVE, 'sub', RESTORE],
      after: { './x.sh': 2, './y.sh': 3 },
    });
    expect(read('cmd /c "cd sub & x.bat" & y.bat', 'windows')).toEqual({
      dirs: [SAVE, 'sub', script('x.bat'), RESTORE, script('y.bat')],
      after: { 'x.bat': 2, 'y.bat': 4 },
    });
  });
});

describe("a folder move made in the line's own process moves it (#717) @cap:executer-une-commande/moteur", () => {
  it.each([
    ['call cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['(cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['if exist a (cd decoy) & x.bat', 'windows', 'x.bat', undefined],
    ['for %d in (a) do cd decoy & x.bat', 'windows', 'x.bat', undefined],
    ['{ cd decoy; } && ./x.sh', 'posix', './x.sh', undefined],
    ['eval "cd decoy"; ./x.sh', 'posix', './x.sh', undefined],
    ['command cd decoy; ./x.sh', 'posix', './x.sh', undefined],
    ['if true; then cd decoy; fi; ./x.sh', 'posix', './x.sh', undefined],
    ['cd decoy || exit 1; ./x.sh', 'posix', './x.sh', undefined],
    // PowerShell: a block, a pipeline, the call operator and iex run in its runspace
    ['(cd decoy); .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['cd decoy | Out-Null; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ["iex 'cd decoy'; .\\x.ps1", 'windows', '.\\x.ps1', 'powershell'],
    ['& { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
    ['Get-Item a | ForEach-Object { cd decoy }; .\\x.ps1', 'windows', '.\\x.ps1', 'powershell'],
  ] as const)('%s', (cmd, host, file, reader) => {
    const { dirs, after } = read(cmd, host, reader);
    expect(after[file]).toBeDefined();
    expect(inForce(dirs, after[file])).toContain('decoy');
  });

  it('a PowerShell subexpression read twice, when it is not quoted, leaves the folder unknown', () => {
    // `$(…)` runs in PowerShell's runspace; the scan reads its commands and so
    // does the reading of substitutions: its move cannot be counted once.
    const { dirs, after } = read('echo $(cd decoy); .\\x.ps1', 'windows', 'powershell');
    expect(inForce(dirs, after['.\\x.ps1'])).toContain(null);
  });
});

describe("a script run in the line's own process leaves it where it ends (#717) @cap:executer-une-commande/moteur", () => {
  it('cmd: a batch file run directly or with call', () => {
    expect(read('setup.bat && cleanup.bat', 'windows')).toEqual({
      dirs: [script('setup.bat'), script('cleanup.bat')],
      after: { 'setup.bat': 0, 'cleanup.bat': 1 },
    });
    expect(read('call setup.cmd & cleanup.bat', 'windows')).toEqual({
      dirs: [script('setup.cmd'), script('cleanup.bat')],
      after: { 'setup.cmd': 0, 'cleanup.bat': 1 },
    });
  });

  it('sh: what `.` and `source` read; a script run directly is a child', () => {
    expect(read('source env.sh && ./x.sh', 'posix')).toEqual({
      dirs: [script('env.sh')],
      after: { 'env.sh': 0, './x.sh': 1 },
    });
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
    expect(read('powershell -File env.ps1 & x.bat', 'windows').dirs).toEqual([script('x.bat')]);
    expect(read('env.ps1 & x.bat', 'windows').dirs).toEqual([script('x.bat')]);
    expect(read('cmd /c env.bat & x.bat', 'windows')).toEqual({
      dirs: [SAVE, script('env.bat'), RESTORE, script('x.bat')],
      after: { 'env.bat': 1, 'x.bat': 3 },
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
      dirs: [SAVE, 'sub', RESTORE, script('x.bat')],
      after: { 'x.bat': 3 },
    });
    // On a command line, setlocal does nothing.
    expect(read('setlocal & cd sub & endlocal & x.bat', 'windows')).toEqual({
      dirs: ['sub', script('x.bat')],
      after: { 'x.bat': 1 },
    });
  });
});

describe('a line whose shell is not known, read as both (#717) @cap:executer-une-commande/moteur', () => {
  it('where cmd and sh read a move differently, the folder after it is not known', () => {
    // a block in cmd, a subshell in sh
    expect(programSources('(cd decoy) && ./x.sh').dirs).toEqual([null]);
    // a batch file of cmd's own process, a program sh starts
    expect(programSources('prepare.bat && x.bat').dirs).toEqual([null, null]);
  });

  it('where they agree, the move is read', () => {
    expect(programSources('cd sub && node build.js').dirs).toEqual(['sub']);
    expect(programSources('bash -c "cd sub" && node build.js').dirs).toEqual([
      SAVE,
      'sub',
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
      expect(writes(cmd, host), cmd).toEqual({ dirs: [SAVE, 'decoy', RESTORE], after: [3] });
    }
  });

  it("read with PowerShell's grammar, `&` only starts the next command of the same process", () => {
    // `&` and `&&` are read as PowerShell's call operator before the next
    // command: in cmd and sh it is the line's own process all the same.
    expect(writes('cd a & cd b & curl -o z.zip https://x/a', 'windows')).toEqual({
      dirs: ['a', 'b'],
      after: [2],
    });
    expect(writes('cd a && cd b && curl -o z.zip https://x/a', 'posix')).toEqual({
      dirs: ['a', 'b'],
      after: [2],
    });
  });

  it('a download inside a child is read from its folder', () => {
    expect(writes('bash -c "cd sub && curl -o a.zip https://x/a"', 'posix')).toEqual({
      dirs: [SAVE, 'sub', RESTORE],
      after: [2],
    });
  });

  it("the line's own process moves it", () => {
    expect(writes('(cd sub) & curl -o a.zip https://x/a', 'windows')).toEqual({
      dirs: ['sub'],
      after: [1],
    });
    expect(writes('{ cd sub; } && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: ['sub'],
      after: [1],
    });
    expect(
      writes('cd sub | Out-Null; iwr https://x/a -OutFile a.zip', 'windows', 'powershell'),
    ).toEqual({ dirs: ['sub'], after: [1] });
  });

  it("a script run in the line's process leaves the download where it ends", () => {
    expect(writes('setup.bat && curl -o a.zip https://x/a', 'windows')).toEqual({
      dirs: [script('setup.bat')],
      after: [1],
    });
    expect(writes('source env.sh && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: [script('env.sh')],
      after: [1],
    });
    expect(writes('.\\env.ps1; iwr https://x/a -OutFile a.zip', 'windows', 'powershell')).toEqual({
      dirs: [script('.\\env.ps1')],
      after: [1],
    });
    expect(writes('bash env.sh && curl -o a.zip https://x/a', 'posix')).toEqual({
      dirs: [],
      after: [0],
    });
  });

  it("a batch file's setlocal", () => {
    expect(
      writes('setlocal & cd sub & endlocal & curl -o a.zip https://x/a', 'windows', 'cmd'),
    ).toEqual({ dirs: [SAVE, 'sub', RESTORE], after: [3] });
  });
});
