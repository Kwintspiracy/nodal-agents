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
import {
  DEFAULT_SHELL_POLICY,
  commandUnits,
  isCatastrophicCommand,
  programSources,
  splitShellWords,
  staticShellCategories,
} from '@nodal-agents/shared';
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

describe("a group's redirection is its commands' (#717, Nodal review pass 9) @cap:executer-une-commande/moteur", () => {
  // Measured: bash writes the output of `( … )`, `{ …; }`, nested groups,
  // `for`/`while`/`if`/`case` to the file after them; cmd.exe the output of
  // `( … )`, nested, and `if … ( … )`; PowerShell the output of `( … )`,
  // `$( … )` and `& { … }`.
  it.each([
    ['posix', '( curl https://x/a ) > ../outside.txt', '../outside.txt'],
    ['posix', '{ curl https://x/a; } > ../outside.txt', '../outside.txt'],
    ['posix', '( ( curl https://x/a ) ) > ../outside.txt', '../outside.txt'],
    ['posix', '{ ( curl https://x/a ); } > ../outside.txt', '../outside.txt'],
    ['posix', 'for i in 1; do curl https://x/a; done > ../outside.txt', '../outside.txt'],
    ['posix', 'while true; do curl https://x/a; done > ../outside.txt', '../outside.txt'],
    ['posix', 'if true; then curl https://x/a; fi > ../outside.txt', '../outside.txt'],
    ['windows', '( curl https://x/a ) > ..\\outside.txt', '..\\outside.txt'],
    ['windows', '( ( curl https://x/a ) ) > ..\\outside.txt', '..\\outside.txt'],
    ['windows', 'if 1==1 ( curl https://x/a ) > ..\\outside.txt', '..\\outside.txt'],
  ] as const)('%s: %s asks', async (host, command, place) => {
    expect(await judge(command, placeWith(host, {}))).toEqual(downloadOutside(command, place));
  });

  it('PowerShell: a parenthesis redirected writes its output', async () => {
    const command = 'powershell -Command "( irm https://x/a ) > ..\\outside.txt"';
    expect(await judge(command, placeWith('windows', {}))).toEqual(
      downloadOutside(command, '..\\outside.txt'),
    );
  });

  it.each([
    ['posix', '( cd ..; curl https://x/a ) > out.txt'],
    ['windows', '(cd .. & curl https://x/a) > out.txt'],
  ] as const)(
    '%s: %s is opened before the group runs, in the folder the line is in',
    async (host, command) => {
      // Measured: bash and cmd.exe write out.txt in the starting folder, not
      // in the one the group moves to. (cmd also looks for `curl` in `..`,
      // which it cannot look into, pass 4: that asks, as inline code.)
      const reasons = await judge(command, placeWith(host, {}));
      expect(reasons.filter((r) => r.category === 'download')).toEqual([]);
    },
  );

  it.each(['posix', 'windows'] as const)(
    '%s: ( npm test ) > log.txt 2>&1 asks nothing',
    async (host) => {
      expect(await judge('( npm test ) > log.txt 2>&1', placeWith(host, {}))).toEqual([]);
    },
  );

  it('a redirection alone runs nothing and lands no download', async () => {
    // bash creates an empty ../x, cmd.exe refuses `> ..\x` (measured): no
    // fetched byte goes there.
    expect(await judge('curl -o a.jpg https://x/a; > ../x', placeWith('posix', {}))).toEqual([]);
    // ...and a group that ended before it (`;`, `&&`, `|`) is not its own.
    for (const command of [
      '( curl -o a.jpg https://x/a ); > ../x',
      '( curl -o a.jpg https://x/a ) && > ../x',
      '( curl -o a.jpg https://x/a ) | > ../x',
    ])
      expect(await judge(command, placeWith('posix', {})), command).toEqual([]);
  });
});

describe('sh compounds nest on every word in command position (#717, Nodal review pass 10) @cap:executer-une-commande/moteur', () => {
  // Measured in bash: `for … do if … fi; done > f`, `while … do case … esac;
  // done > f` and three levels write what runs inside to f; `if …; then echo
  // X; for … done > f; fi` writes only the loop's output there.
  it.each([
    'for u in "$@"; do if [[ $u == https* ]]; then curl "$u"; fi; done > ../log',
    'while read l; do case $l in a) curl https://x/a;; esac; done > ../log',
    'for i in 1; do while true; do if true; then curl https://x/a; fi; break; done; done > ../log',
    'if true; then while true; do ! curl https://x/a; break; done; fi > ../log',
    '! for i in 1; do curl https://x/a; done > ../log',
  ])('%s asks', async (command) => {
    expect(await judge(command, placeWith('posix', {}))).toEqual(
      downloadOutside(command, '../log'),
    );
  });

  it("a loop's redirection inside an if is the loop's, not the if's first command's", async () => {
    // `curl https://x/a` prints to the terminal; only the loop's `echo` goes to ../f.
    expect(
      await judge(
        'if true; then curl https://x/a; for i in 1; do echo hi; done > ../f; fi',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
    expect(
      await judge(
        'if true; then for i in 1; do echo hi; done > ../f; curl https://x/a; fi',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
    // a loop that opens in the condition of an `if` is a compound of its own:
    // its `done` closes it, the `fi` the if, never the `for` around them
    expect(
      await judge(
        'for i in 1; do curl https://x/a; if while false; do :; done; then :; fi > ../f; done',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
    // the loop opens right after `else`: still a loop of its own
    expect(
      await judge(
        'if false; then curl https://x/a; else for i in 1; do echo hi; done > ../f; fi',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
  });
});

describe('a case pattern is no reserved word, and time, coproc, ! lead to a command (#717, Nodal review pass 11) @cap:executer-une-commande/moteur', () => {
  // Measured in bash: `done)`, `if)`, `for)`, `(done)`, `\done)`, `d\one)`,
  // `"done")` are patterns whose clause runs, the case's output written to
  // the file after `esac`; `time for …`, `time -p for …`, `coproc { …; }`,
  // `coproc NAME { …; }` write theirs to the file after them.
  it.each([
    'case $x in\ndone) curl https://x/a;;\nesac > ../f',
    'case $x in\nif) curl https://x/a;;\nfor) echo;;\nesac > ../f',
    'case $x in\n(done) curl https://x/a;;\nesac > ../f',
    'case $x in\n\\done) curl https://x/a;;\nesac > ../f',
    'case $x in\nd\\one) curl https://x/a;;\nesac > ../f',
    'case $x in\n"done") curl https://x/a;;\nesac > ../f',
    'case $x in\na) echo;&\ndone) curl https://x/a;;\nesac > ../f',
    'case $x in done) curl https://x/a;; esac > ../f',
    // past its pattern, a clause's `( … )` is a subshell, no second pattern
    'case $x in\ndone) ( curl https://x/a ) > ../f;;\nesac',
    'case $x in done) ( curl https://x/a ) > ../f;; esac',
    'case $x in\nstart|done) curl https://x/a;;\nesac > ../f',
    'time for i in 1; do curl https://x/a; done > ../f',
    'time -p for i in 1; do curl https://x/a; done > ../f',
    'coproc { curl https://x/a; } > ../f',
    'coproc NAME { curl https://x/a; } > ../f',
    'coproc while true; do curl https://x/a; break; done > ../f',
  ])('%s asks', async (command) => {
    expect(await judge(command, placeWith('posix', {}))).toEqual(downloadOutside(command, '../f'));
  });

  it("a pattern named after a closer closes nothing: the loop's redirection is the loop's", async () => {
    // curl prints to the terminal; only the case writes to ../f.
    expect(
      await judge(
        'for i in 1; do curl https://x/a; case $x in\ndone) echo;;\nesac > ../f; done',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
    // `\fi` is a command (bash: `fi: command not found`, ../f created
    // empty, `inner` to the terminal): the real `fi` closes the if.
    expect(
      await judge('if true; then curl https://x/a; \\fi > ../f; fi', placeWith('posix', {})),
    ).toEqual([]);
  });

  it('`;&` falls through in the same shell: a cd before it moves what follows', async () => {
    // Measured: `a) cd sub;& b) pwd` prints …/sub.
    expect(
      await judge(
        'case $x in\na) cd sub;&\nb) ./run.sh;;\nesac',
        placeWith('posix', { 'run.sh': 'echo done\n', 'sub/run.sh': 'rm -rf build\n' }),
      ),
    ).toEqual([expect.objectContaining({ category: 'delete_files' })]);
  });

  it("a pattern keeps its clause's commands may-not-run: the folder before the move is read too", async () => {
    // `. ./go.sh` (which enters sub) runs only when $x is `done`: ./run.sh
    // may be the starting folder's, which deletes.
    const files = { 'go.sh': 'cd sub\n', 'run.sh': 'rm -rf build\n', 'sub/run.sh': 'echo done\n' };
    for (const command of [
      'case $x in\ndone) . ./go.sh;;\nesac\n./run.sh',
      'case $x in\ndone) cd sub;;\nesac\n./run.sh',
    ])
      expect(await judge(command, placeWith('posix', files)), command).toEqual([
        expect.objectContaining({ category: 'delete_files' }),
      ]);
    // The reading itself: the script may not have run, so past its chain the
    // line is where it was or where the script left it (a cd inside a script
    // is unsure anyway, which the gate's verdict alone does not show).
    expect(
      programSources('case $x in\ndone) . ./go.sh;;\nesac\n./run.sh', {
        direct: true,
        host: 'posix',
      }).dirs,
    ).toEqual([{ script: './go.sh' }, { unsure: 0 }]);
  });

  it('an ordinary case on several lines asks nothing', async () => {
    expect(
      await judge(
        'case $1 in\nstart) npm start;;\nstop) npm stop;;\n*) echo usage;;\nesac > log.txt 2>&1',
        placeWith('posix', {}),
      ),
    ).toEqual([]);
  });
});

describe('one reader of case patterns, as bash reads them (#717, Nodal review pass 12) @cap:executer-une-commande/moteur', () => {
  // Measured in bash (`-O extglob`): a clause after `@(dev|prod))`,
  // `!(z))` runs; `@(a|b(c)))` parses; `(case …;; esac) > f` and
  // `$(case …;; esac)` write what the case prints; a case after `then`,
  // `do`, `else`, `if`, `!`, `time`, `coproc` reads its patterns, `done)`
  // among them.
  it.each([
    'case $mode in @(dev|prod)) (rm -rf build);; esac',
    'case $x in !(z)) (rm -rf build);; esac',
    'case $x in @(a|b(c))) (rm -rf build);; esac',
  ])('%s: the clause after an extglob pattern is read', async (command) => {
    expect(staticShellCategories(command, 'posix')).toContain('delete_files');
    expect(await judge(command, placeWith('posix', {}))).toContainEqual(
      expect.objectContaining({ category: 'delete_files' }),
    );
    // the whole pattern is one, read to its last `)`: no piece of it is a
    // command (`@`, `!`), and the clause is the command after it
    expect(splitShellWords(command, 'sh').slice(1)).toEqual([['rm', '-rf', 'build'], ['esac']]);
  });

  it.each([
    'if true; then case $x in done) curl https://x/a;; esac > ../f; fi',
    'for f in 1; do case $f in done) curl https://x/a;; esac > ../f; done',
    'if false; then :; else case $x in done) curl https://x/a;; esac > ../f; fi',
    'if case $x in done) curl https://x/a;; esac > ../f; then :; fi',
    '! case $x in done) curl https://x/a;; esac > ../f',
    'time case $x in done) curl https://x/a;; esac > ../f',
    'coproc case $x in done) curl https://x/a;; esac > ../f',
  ])('%s: the case, wherever a command starts, ends at `in`; `done)` is its pattern', (command) => {
    const words = splitShellWords(command, 'sh');
    expect(words.find((s) => s.includes('case'))?.at(-1)).toBe('in');
    expect(words).toContainEqual(['curl', 'https://x/a']);
  });

  it.each([
    '(case $x in a) curl https://x/a;; esac) > ../f',
    'if true; then case $x in done) curl https://x/a;; esac > ../f; fi',
    'for f in 1; do case $f in done) curl https://x/a;; esac > ../f; done',
    'if false; then :; else case $x in done) curl https://x/a;; esac > ../f; fi',
    'if case $x in done) curl https://x/a;; esac > ../f; then :; fi',
    '! case $x in done) curl https://x/a;; esac > ../f',
    'time case $x in done) curl https://x/a;; esac > ../f',
    'coproc case $x in done) curl https://x/a;; esac > ../f',
  ])('%s asks', async (command) => {
    expect(await judge(command, placeWith('posix', {}))).toEqual(downloadOutside(command, '../f'));
  });

  it('a case in a substitution asks nothing', async () => {
    for (const command of [
      'v=$(case $x in a) echo hi;; esac); echo "$v" > out.txt',
      'v="$(case $x in a) echo hi;; esac)"',
    ])
      expect(await judge(command, placeWith('posix', {})), command).toEqual([]);
  });

  it('a pattern that never ends is said: the line asks', async () => {
    // bash refuses it (`syntax error near unexpected token ;;`).
    expect(await judge('case $x in\na;;\nesac', placeWith('posix', {}))).toContainEqual(
      expect.objectContaining({ category: 'inline_code' }),
    );
    // ...and is no longer awaited: what follows is read as commands, never
    // swallowed as the pattern still expected
    expect(staticShellCategories('case $x in\na b\n(rm -rf build)\nesac', 'posix')).toEqual(
      expect.arrayContaining(['inline_code', 'delete_files']),
    );
  });
});

describe('a substitution is code wherever it stands, nested ones read whole (#717, Nodal review pass 13) @cap:executer-une-commande/moteur', () => {
  // Measured in bash: `case $x in $(touch m1 $(echo m2))) :;; esac` creates
  // m1 and m2, `` `touch m3`) `` m3, `$(touch "m4(b)"))` m4(b), and the
  // same in `bash -c '…'` m5 and m6; `$(( 1+1 )))` is arithmetic;
  // `echo $(echo a $(echo b) c)` prints `a b c`.
  it.each([
    'case $x in $(rm -rf / $(echo x))) :;; esac',
    "bash -c 'case $x in $(rm -rf / $(echo x))) :;; esac'",
    'case $x in `rm -rf /`) :;; esac',
    'cat <<EOF\n$(rm -rf / $(echo x))\nEOF',
    // in double quotes only the substitution pass reads them: a case's
    // pattern `)`, a quoted `(` close nothing
    'echo "$(case $x in a) rm -rf /;; esac)"',
    `echo "$(echo '(' ; rm -rf /)"`,
    'echo "$(echo "(" ; rm -rf /)"',
  ])('%s: the floor sees rm -rf /', (command) => {
    expect(isCatastrophicCommand(command, 'posix')).toBe(true);
  });

  it('an arithmetic expansion is no code: a variable named like a program runs nothing', () => {
    expect(staticShellCategories('echo "$(( kill + 1 ))"', 'posix')).toEqual([]);
  });

  it('a substitution with a quoted parenthesis in a pattern is read', () => {
    expect(staticShellCategories('case $x in $(rm -rf "/tmp/a(b)")) :;; esac', 'posix')).toContain(
      'delete_files',
    );
  });

  it('an arithmetic pattern asks nothing', async () => {
    expect(await judge('case $x in $(( 1+1 ))) echo hi;; esac', placeWith('posix', {}))).toEqual(
      [],
    );
  });

  it('every command of nested substitutions is read, quoted or not', () => {
    for (const command of ['echo "$(touch a $(rm -rf b) c)"', 'echo $(touch a $(rm -rf b) c)']) {
      const heads = commandUnits(command, 0, 'sh').map((u) => u[0]);
      expect(heads, command).toEqual(expect.arrayContaining(['touch', 'rm', 'c']));
    }
  });
});

describe('a substitution is never dropped, and read with the grammar the scan knows (#717, Nodal review pass 14) @cap:executer-une-commande/moteur', () => {
  // Measured in bash: each of these runs its `touch` (t1 … t5):
  // `echo $'a\'b'; touch t1`, `"$(echo case; touch t2)"`,
  // `"$(touch t3; echo $'a\'b')"`, `"$(echo ${x//)/}; touch t4)"`, and
  // `"$(echo a # )⏎touch t5)"`.
  it.each([
    'echo "$(echo case; rm -rf /)"',
    'echo "$(grep case x; rm -rf /)"',
    "echo \"$(rm -rf /; echo $'a\\'b')\"",
    "echo \"$(echo $'a\\'b'; rm -rf /)\"",
    "echo $'a\\'b'; rm -rf /",
    'echo "$(echo ${x//)/}; rm -rf /)"',
    'echo "$(echo $[1)]; rm -rf /)"',
    'echo "$(case $x in a) echo esac;; b) rm -rf /;; esac)"',
    'echo "$(echo a # )\nrm -rf /)"',
    // a substitution that never closes: what follows is read as code
    'echo "$(echo hi; rm -rf /"',
  ])('%s: the floor sees rm -rf /', (command) => {
    expect(isCatastrophicCommand(command, 'posix')).toBe(true);
  });

  it.each([
    'Write-Output "$(Write-Output a # )\nRemove-Item -Recurse build)"',
    'Write-Output "$(<# ) #> Remove-Item -Recurse build)"',
  ])('PowerShell: %s, a comment closes nothing', (command) => {
    expect(staticShellCategories(command, undefined, 'powershell')).toContain('delete_files');
  });

  it('nested ten thousand deep: no crash, and the line asks', async () => {
    const n = 10_000;
    for (const command of [
      'echo "' + '$(echo "'.repeat(n) + 'x' + '")'.repeat(n) + '"',
      'echo $((' + '$(('.repeat(n) + '1' + '))'.repeat(n) + '))',
    ]) {
      expect(() => isCatastrophicCommand(command, 'posix')).not.toThrow();
      expect(await judge(command, placeWith('posix', {}))).toContainEqual(
        expect.objectContaining({ category: 'inline_code' }),
      );
    }
  });

  it.each([
    ['posix', 'echo $((a+b))'],
    ['posix', 'echo "$(date)"'],
    ['posix', 'git commit -m "$(cat msg)"'],
    ['posix', 'echo "$(case $x in a) echo hi;; esac)"'],
  ] as const)('%s: %s asks nothing', async (host, command) => {
    expect(await judge(command, placeWith(host, {}))).toEqual([]);
  });

  it('PowerShell: "$($x.Name)" is no action', () => {
    expect(staticShellCategories('Write-Output "$($x.Name)"', undefined, 'powershell')).toEqual([]);
  });

  // A substitution whose end the reading finds where the shell finds it reads
  // no more than it holds: the quoted `; rm -rf / ` after it is text (bash
  // prints it). Read past a wrong end, it would be code: the over-read the
  // fallback allows.
  it.each([
    'echo "$(echo case in x) ; rm -rf / "',
    "echo \"$(echo $'a\\'b') ; rm -rf / \"",
    'echo "$(case $x in a) echo hi;; esac) ; rm -rf / "',
  ])('%s: the floor sees no rm -rf /', (command) => {
    expect(isCatastrophicCommand(command, 'posix')).toBe(false);
  });

  it('PowerShell: a comment in the line is no code', () => {
    expect(
      staticShellCategories(
        'Write-Output hi # ; Remove-Item -Recurse build',
        undefined,
        'powershell',
      ),
    ).toEqual([]);
  });
});
