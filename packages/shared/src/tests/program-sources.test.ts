// program-sources.test.ts — where the code a command runs is: a file it hands
// to an interpreter or runs directly, or code written into it (#635).

import { describe, it, expect } from 'vitest';
import {
  languageOfPath,
  hereDocs,
  stdinReceiver,
  DATA_CONSUMERS,
  RUNS_ANOTHER_PROGRAMS,
  interpreterKind,
  isCatastrophicCommand,
  SHELLS,
  SHELL_PROGRAMS,
  isDestructiveOrHeavyCommand,
  computeApprovalImpactLine,
  languageOfShebang,
  programSources,
  staticShellCategories,
  type ProgramSource,
  type SourceLanguage,
} from '../index';

/** The files and code a command runs, without the bookkeeping. */
function sources(cmd: string, direct = true): Array<Partial<ProgramSource>> {
  // Read on the host its paths are written for: a backslash is a separator for
  // cmd and PowerShell, an escape for sh (a line whose host is not known is
  // read both ways, and both readings are kept).
  const host = /[\\]/.test(cmd) ? 'windows' : 'posix';
  return programSources(cmd, { direct, host }).sources.map((s) =>
    s.kind === 'file'
      ? { kind: s.kind, path: s.path, language: s.language }
      : { kind: s.kind, code: s.code, language: s.language },
  );
}

describe('programSources: where the code a command runs is (#635) @cap:executer-une-commande/moteur', () => {
  it('a file given to an interpreter, in every language and form', () => {
    const cases: Array<[string, string, SourceLanguage]> = [
      // The run of the ticket (074e7161).
      [
        'python shared/scripts/_temp_create_ventes_bench.py',
        'shared/scripts/_temp_create_ventes_bench.py',
        'python',
      ],
      ['python3 -u -W ignore x.py --out a.xlsx', 'x.py', 'python'],
      ['py -3.11 x.py', 'x.py', 'python'],
      ['C:\\Python311\\python.exe "C:/My Files/x.py"', 'C:/My Files/x.py', 'python'],
      ['node --require ./setup.js build.mjs', 'build.mjs', 'javascript'],
      ['tsx scripts/gen.ts', 'scripts/gen.ts', 'javascript'],
      ['deno run --allow-net main.ts', 'main.ts', 'javascript'],
      ['bun run x.ts', 'x.ts', 'javascript'],
      ['perl tool.pl', 'tool.pl', 'perl'],
      ['ruby -w tool.rb', 'tool.rb', 'ruby'],
      ['php -f index.php', 'index.php', 'php'],
      ['bash -e build.sh -clean', 'build.sh', 'shell'],
      ['sh -o pipefail run', 'run', 'shell'],
      [
        'powershell -NoProfile -ExecutionPolicy Bypass -File .\\setup.ps1',
        '.\\setup.ps1',
        'powershell',
      ],
      ['pwsh -f setup.ps1', 'setup.ps1', 'powershell'],
      ['powershell .\\setup.ps1', '.\\setup.ps1', 'powershell'],
      ['sudo env FOO=1 python x.py', 'x.py', 'python'],
    ];
    for (const [cmd, path, language] of cases) {
      expect(sources(cmd), cmd).toEqual([{ kind: 'file', path, language }]);
    }
  });

  it('a file run directly: a relative path, a script name, source and call', () => {
    expect(sources('./run.sh arg')).toEqual([
      { kind: 'file', path: './run.sh', language: 'shell' },
    ]);
    expect(sources('scripts\\setup.bat')).toEqual([
      { kind: 'file', path: 'scripts\\setup.bat', language: 'cmd' },
    ]);
    expect(sources('cmd /c setup.bat')).toEqual([
      { kind: 'file', path: 'setup.bat', language: 'cmd' },
    ]);
    // No extension: the file says (a shebang), or it is a program.
    expect(sources('node_modules/.bin/vite build')).toEqual([
      { kind: 'file', path: 'node_modules/.bin/vite', language: null },
    ]);
    expect(sources('source ./env.sh && . ./more.sh')).toEqual([
      { kind: 'file', path: './env.sh', language: 'shell' },
      { kind: 'file', path: './more.sh', language: 'shell' },
    ]);
    expect(sources('call build.cmd')).toEqual([
      { kind: 'file', path: 'build.cmd', language: 'cmd' },
    ]);
  });

  it('a bare name is looked up on the PATH when it is not in the folder', () => {
    const [bare] = programSources('setup.bat').sources;
    const [relative] = programSources('.\\setup.bat').sources;
    expect(bare).toMatchObject({ kind: 'file', searched: true, executed: true });
    expect(relative).toMatchObject({ kind: 'file', searched: false, executed: true });
    // A file an interpreter reads is source, not a program.
    expect(programSources('python x.py').sources[0]).toMatchObject({ executed: false });
  });

  it('the code written into a command, for an interpreter whose code is not a command line', () => {
    expect(sources(`python -c "import os; os.system('pip install x')"`)).toEqual([
      { kind: 'code', code: "import os; os.system('pip install x')", language: 'python' },
    ]);
    expect(sources(`node -e "require('child_process').execSync('npm i x')"`)).toEqual([
      {
        kind: 'code',
        code: "require('child_process').execSync('npm i x')",
        language: 'javascript',
      },
    ]);
    expect(sources(`ruby -e "system('gem install x')"`)).toEqual([
      { kind: 'code', code: "system('gem install x')", language: 'ruby' },
    ]);
    expect(sources(`php -r "shell_exec('composer install');"`)).toEqual([
      { kind: 'code', code: "shell_exec('composer install');", language: 'php' },
    ]);
    // Windows PowerShell reads a first word that is not a script as a command.
    expect(sources('powershell pip install x')).toEqual([
      { kind: 'code', code: 'pip install x', language: 'powershell' },
    ]);
  });

  it('what is not a source: modules, command lines already read, subcommands, programs', () => {
    for (const cmd of [
      'python -m pip install x',
      'python -m venv .venv',
      'bash -c "pip install x"',
      'powershell -Command "pip install x"',
      'bun install',
      'deno fmt',
      'node',
      'python',
      '/usr/bin/git status',
      'C:\\tools\\rg.exe -n x',
      'git status',
      'ls -la',
    ]) {
      expect(sources(cmd), cmd).toEqual([]);
    }
  });

  it('a path decided when the command runs is named as such, not guessed', () => {
    const [s] = programSources('python $SCRIPT').sources;
    expect(s).toMatchObject({ kind: 'file', path: null });
  });

  it('a cd before the file moves where it is read from', () => {
    const read = programSources('cd sub && node build.js');
    expect(read.dirs).toEqual(['sub']);
    expect(read.sources).toEqual([
      {
        kind: 'file',
        path: 'build.js',
        language: 'javascript',
        after: 1,
        searched: false,
        executed: false,
      },
    ]);
  });

  it('in the strings of a script, a file name is data unless an interpreter is given it', () => {
    expect(sources('helpers.py', false)).toEqual([]);
    expect(sources('python helpers.py', false)).toEqual([
      { kind: 'file', path: 'helpers.py', language: 'python' },
    ]);
  });
});

describe('a shell runs its -c even in a group of options (#635) @cap:executer-une-commande/moteur', () => {
  it('bash -lc and sh -ec are read like bash -c', () => {
    expect(staticShellCategories('bash -lc "pip install x"')).toEqual([
      'install_software',
      'inline_code',
    ]);
    expect(staticShellCategories('sh -ec "rm -rf build"')).toEqual(['delete_files', 'inline_code']);
    expect(staticShellCategories('bash -o pipefail -c "pip install x"')).toEqual([
      'install_software',
      'inline_code',
    ]);
  });

  it("an option after the script file is the script's own", () => {
    expect(staticShellCategories('bash build.sh -clean')).toEqual([]);
  });
});

describe('the language of a file (#635) @cap:executer-une-commande/moteur', () => {
  it('by its extension, then by its shebang', () => {
    expect(languageOfPath('a/b/x.PY')).toBe('python');
    expect(languageOfPath('run.bat')).toBe('cmd');
    expect(languageOfPath('setup.ps1')).toBe('powershell');
    expect(languageOfPath('tool')).toBeNull();
    expect(languageOfShebang('#!/usr/bin/env python3\nprint(1)')).toBe('python');
    expect(languageOfShebang('#!/usr/bin/env -S node --no-warnings\n')).toBe('javascript');
    expect(languageOfShebang('#!/bin/bash\n')).toBe('shell');
    expect(languageOfShebang('echo hi')).toBeNull();
  });
});

// Review pass 1 of #683 (P2): the command a control construct runs is the
// command after its keyword or its opening bracket, in sh, cmd and PowerShell.
describe('a control construct runs the command after its keyword (review of #683) @cap:executer-une-commande/moteur', () => {
  it('sh: if/then/else, while/do, groups and sub-shells', () => {
    for (const cmd of [
      'if true; then pip install openpyxl; fi',
      'if ! pip install x; then echo no; fi',
      'if test -f a; then echo a; else pip install x; fi',
      'while read p; do pip install "$p"; done < req.txt',
      'for p in a b; do pip install $p; done',
      '(cd sub && pip install x)',
      '{ pip install x; }',
      'time pip install x',
    ]) {
      expect(staticShellCategories(cmd), cmd).toContain('install_software');
    }
  });

  it('cmd: if … ( … ), for … do, call inside a block', () => {
    for (const cmd of [
      'if exist req.txt (pip install -r req.txt)',
      'if not errorlevel 1 (rd /s /q build)',
      'for %i in (a b) do pip install %i',
      'for %i in (a b) do (call npm ci)',
    ]) {
      expect(staticShellCategories(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  it('PowerShell: if/foreach/while script blocks', () => {
    expect(staticShellCategories('if ($true) { pip install x }')).toContain('install_software');
    expect(staticShellCategories('foreach ($p in $l) { Remove-Item $p }')).toContain(
      'delete_files',
    );
    expect(staticShellCategories('while ($i -lt 3) { Stop-Process -Name x }')).toContain(
      'stop_programs',
    );
  });

  it('a bracket inside an argument is not a command (review of PR #474)', () => {
    expect(staticShellCategories('echo "(rm -rf x)"')).toEqual([]);
    expect(staticShellCategories('git commit -m "{pip install x}"')).toEqual([]);
    expect(staticShellCategories('echo then rm')).toEqual([]);
  });
});

// Review pass 2 of #683 (C2): a command starts at every position the grammar
// of sh, cmd or PowerShell opens to one, and a reserved word is never the
// program that hides what follows it.
describe('a command starts where the shell grammar lets one start (review pass 2 of #683) @cap:executer-une-commande/moteur', () => {
  const kinds = (cmd: string): string[] => staticShellCategories(cmd);

  it('sh: case patterns, select, function bodies, eval and exec', () => {
    for (const cmd of [
      'case $x in *) pip install openpyxl ;; esac',
      'case $x in a|b) pip install openpyxl ;; esac',
      'select p in a b; do pip install $p; done',
      'function f { pip install x; }',
      'f() { pip install x; }',
      'coproc pip install x',
      'eval "pip install x"',
      'exec pip install x',
      'if [ -f a ]; then echo a; elif [ -f b ]; then pip install x; fi',
    ]) {
      expect(kinds(cmd), cmd).toContain('install_software');
    }
  });

  it('cmd: brackets, else and do', () => {
    expect(kinds('if exist a (echo a) else (pip install x)')).toContain('install_software');
    expect(kinds('for /f %i in (list.txt) do (pip install %i)')).toContain('install_software');
  });

  it('PowerShell: every script block, and Invoke-Expression', () => {
    for (const cmd of [
      'switch ($x) { 1 { Stop-Process -Name excel } }',
      'function F { Stop-Process -Name excel }',
      'filter F { Stop-Process -Name excel }',
      'try { Stop-Process -Name excel } catch { }',
      'try { echo a } finally { Stop-Process -Name excel }',
      'trap { Stop-Process -Name excel }',
      'Get-Process | ForEach-Object { Stop-Process -Id $_.Id }',
      'iex "Stop-Process -Name excel"',
    ]) {
      expect(kinds(cmd), cmd).toContain('stop_programs');
    }
  });

  it('what is quoted is an argument, wherever its brackets and keywords are', () => {
    expect(kinds('echo "a)" "rm -rf x"')).toEqual([]);
    expect(kinds('echo "{" "pip install x"')).toEqual([]);
    expect(kinds('echo do rm -rf x')).toEqual([]);
    expect(kinds("awk '{print $1}' file")).toEqual([]);
  });
});

// Before review pass 3 of #683: the two gaps the PR declared.
describe('cmd conditions without brackets, and here-docs fed to a program (#683) @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const kinds = (cmd: string): string[] => staticShellCategories(cmd);

  it('cmd: the command after an if condition, without brackets', () => {
    const cases: Array<[string, string]> = [
      ['if exist req.txt pip install -r req.txt', 'install_software'],
      ['if not exist x rmdir /s /q build', 'delete_files'],
      ['if errorlevel 1 taskkill /im x.exe', 'stop_programs'],
      ['if /i "%a%"=="b" del x', 'delete_files'],
      ['if /i "%a%" == "b" del x', 'delete_files'],
      ['if defined X pip install y', 'install_software'],
      ['if %x%==1 pip install y', 'install_software'],
      ['if %x% EQU 1 del x', 'delete_files'],
      ['if not %x% GEQ 2 taskkill /im y.exe', 'stop_programs'],
      ['if cmdextversion 2 del x', 'delete_files'],
      ['for %f in (*.txt) do pip install %f', 'install_software'],
      ['for /f "tokens=*" %a in (\'dir /b\') do pip install %a', 'install_software'],
      // `for /f` runs the command in its brackets.
      ['for /f "delims=" %a in (\'pip install x\') do echo %a', 'install_software'],
    ];
    for (const [cmd, kind] of cases) expect(kinds(cmd), cmd).toContain(kind);
  });

  it('a here-doc or here-string fed to a shell or an interpreter is its source', () => {
    const code = (cmd: string) =>
      programSources(cmd).sources.flatMap((s) =>
        s.kind === 'code' ? [{ language: s.language, code: s.code.trim() }] : [],
      );
    expect(code(`bash <<EOF${NL}pip install x${NL}EOF`)).toEqual([
      { language: 'shell', code: 'pip install x' },
    ]);
    expect(code(`sh <<'EOF'${NL}rm -rf build${NL}EOF`)).toEqual([
      { language: 'shell', code: 'rm -rf build' },
    ]);
    expect(code(`python - <<EOF${NL}import os${NL}os.system("pip install x")${NL}EOF`)).toEqual([
      { language: 'python', code: `import os${NL}os.system("pip install x")` },
    ]);
    expect(code(`node <<-END${NL}	require('child_process').execSync('npm i x')${NL}	END`)).toEqual([
      { language: 'javascript', code: "require('child_process').execSync('npm i x')" },
    ]);
    expect(code('bash <<< "pip install x"')).toEqual([
      { language: 'shell', code: 'pip install x' },
    ]);
    expect(code(`@"${NL}Stop-Process -Name excel${NL}"@ | powershell -`)).toEqual([
      { language: 'powershell', code: 'Stop-Process -Name excel' },
    ]);
  });

  it('a file fed on standard input to a shell or an interpreter is its source', () => {
    const files = (cmd: string) =>
      programSources(cmd).sources.flatMap((s) =>
        s.kind === 'file' ? [{ path: s.path, language: s.language }] : [],
      );
    expect(files('cmd < setup.txt')).toEqual([{ path: 'setup.txt', language: 'cmd' }]);
    expect(files('python - < tool.py')).toEqual([{ path: 'tool.py', language: 'python' }]);
    expect(files('bash < run.sh')).toContainEqual({ path: 'run.sh', language: 'shell' });
    expect(files('sort < data.txt')).toEqual([]);
  });

  // Review pass 4 of #683: nothing is taken away from what is judged. A body
  // fed to any other program is no source, and its lines stay commands too:
  // over-asking is accepted, under-reporting is not.
  // Review pass 5 of #683: as sh reads it, a body fed to anything but a shell
  // is data (but for the substitutions of an unquoted one).
  it('a here-doc fed to anything else is data to sh, and no source', () => {
    expect(programSources(`cat <<EOF${NL}pip install x${NL}EOF`).sources).toEqual([]);
    expect(
      staticShellCategories(
        `cat <<EOF > notes.txt${NL}rm -rf build${NL}pip install x${NL}EOF`,
        'posix',
      ),
    ).toEqual([]);
    expect(
      staticShellCategories(`$s = @"${NL}Stop-Process -Name excel${NL}"@`, undefined, 'powershell'),
    ).toEqual([]);
    expect(kinds(`cat <<EOF > a${NL}x${NL}EOF${NL}pip install y`)).toEqual(['install_software']);
  });

  // Review pass 4 of #683 (P2): what main judged in a here-document, every
  // reader still judges: destructive_gate and the card's impact line.
  it('destructive_gate and the impact line still see a body fed to a shell', () => {
    const cmd = `bash <<EOF${NL}Stop-Process -Name excel${NL}EOF`;
    expect(isDestructiveOrHeavyCommand(cmd)).toBe(true);
    expect(computeApprovalImpactLine('run_command', { command: cmd })).toContain(
      'stops other programs or services',
    );
  });
});

// Review pass 3 of #683 (C2): only an operator sh reads opens a here-document,
// and a body without its end marker leaves every line judged.
describe('here-document operators as sh reads them (review pass 3 of #683) @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const kinds = (cmd: string): string[] => staticShellCategories(cmd, 'posix').sort();

  it('a << in quotes, in a comment or in arithmetic opens nothing', () => {
    for (const first of [
      'echo "usage: <<END"',
      "echo 'x <<END'",
      '# <<END',
      'x=$((a << END))',
      // Review pass 4 of #683: sh's comment after `)`, and `(( ))` arithmetic.
      'x)#<<END',
      'f()#<<END',
      '((x<<END))',
      'let "y = x << END"',
      '[[ $a <<END ]]',
    ]) {
      // An END line follows: opened wrongly, a body would swallow the install.
      const text = [first, 'pip install openpyxl', 'END', 'rm -rf build'].join(NL);
      expect(hereDocs(text), first).toEqual([]);
      expect(kinds(text), first).toEqual(['delete_files', 'install_software']);
    }
  });

  it('a body whose end marker never comes stays judged, line by line', () => {
    const text = ['cat <<END > notes.txt', 'pip install openpyxl', 'rm -rf build'].join(NL);
    expect(hereDocs(text)).toEqual([]);
    expect(kinds(text)).toEqual(['delete_files', 'install_software']);
  });
});

// Review pass 5 of #683: a here-document's body is data to the scan of sh, so
// a quote or a `$((` in it changes nothing after it; the shell it feeds runs
// its lines, and an unquoted one runs its substitutions.
describe('a here-document body is no script grammar (review pass 5 of #683) @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const posix = (cmd: string): string[] => staticShellCategories(cmd, 'posix').sort();
  const python = (first: string): string =>
    [
      'cat <<END > notes.txt',
      first,
      'END',
      "python3 - <<'PY'",
      'subprocess.check_call([sys.executable, "-m", "pip", "install", "evil"])',
      'PY',
    ].join(NL);

  it('an apostrophe, a quote or a $(( in a body leaves the next here-document whole', () => {
    for (const first of ["Don't panic", 'say "hi', 'x = $((1 +']) {
      const text = python(first);
      expect(
        hereDocs(text).map((d) => d.before.trim()),
        first,
      ).toEqual(['cat', 'python3 -']);
      expect(
        programSources(text, { direct: true, host: 'posix' }).sources.flatMap((x) =>
          x.kind === 'code' ? [x.language] : [],
        ),
        first,
      ).toEqual(['python']);
    }
  });

  it('the substitutions of an unquoted body run; a quoted body is data', () => {
    expect(posix(`cat <<EOF${NL}$(rm -rf build)${NL}EOF`)).toEqual(['delete_files']);
    expect(posix(`cat <<EOF${NL}\`pip install x\`${NL}EOF`)).toEqual(['install_software']);
    expect(posix(`cat <<'EOF'${NL}$(rm -rf build)${NL}EOF`)).toEqual([]);
    expect(posix(`cat <<"EOF"${NL}$(rm -rf build)${NL}EOF`)).toEqual([]);
  });

  it('a body fed to a shell runs as its commands, quoted marker or not', () => {
    expect(posix(`bash <<'EOF'${NL}rm -rf build${NL}EOF`)).toEqual(['delete_files']);
    expect(posix(`sh <<EOF${NL}pip install x${NL}EOF`)).toEqual(['install_software']);
  });

  it('an unterminated body stays read as lines', () => {
    expect(posix(`cat <<EOF${NL}rm -rf build`)).toEqual(['delete_files']);
  });
});

// Review pass 6 of #683: who reads a here-document is found by the common
// reading of its line, and a body is data only when that is proven.
describe('the reader of what a command feeds on its input (review pass 6 of #683) @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const posix = (cmd: string): string[] => staticShellCategories(cmd, 'posix').sort();
  const body = (opening: string, closing = ''): string =>
    [opening, 'rm -rf build', 'EOF', ...(closing === '' ? [] : [closing])].join(NL);

  it('a shell reached through a pipe or a wrapper runs the body', () => {
    for (const [opening, closing] of [
      ["cat <<'EOF' | sh", ''],
      ['cat <<EOF | bash -s', ''],
      ['nohup bash <<EOF', ''],
      ['command sh <<EOF', ''],
      ['exec sh <<EOF', ''],
      ['time sh <<EOF', ''],
      ['timeout 5 sh <<EOF', ''],
      ['sudo -u builder sh <<EOF', ''],
      ['for f in *; do bash <<EOF', 'done'],
      ['if bash <<EOF', 'then :; fi'],
      ['csh <<EOF', ''],
      ['tcsh <<EOF', ''],
    ] as const) {
      expect(posix(body(opening, closing)), opening).toContain('delete_files');
    }
  });

  it('an interpreter reached through a pipe reads the body as its source', () => {
    const text = ["cat <<'EOF' | python3 -", 'import os', 'os.system("pip install x")', 'EOF'].join(
      NL,
    );
    expect(
      programSources(text, { direct: true, host: 'posix' }).sources.flatMap((s) =>
        s.kind === 'code' ? [s.language] : [],
      ),
    ).toEqual(['python']);
  });

  it('a body is data only when a known data reader reads it, piped to nothing that runs', () => {
    expect(posix(body("cat <<'EOF' > notes.txt"))).toEqual([]);
    expect(posix(body("cat <<'EOF' | grep build"))).toEqual([]);
    expect(posix(body("tee notes.txt <<'EOF'"))).toEqual([]);
    // A reader the reading cannot place: judged as commands.
    expect(posix(body("myprog <<'EOF'"))).toContain('delete_files');
    expect(posix(body("$RUNNER <<'EOF'"))).toContain('delete_files');
    expect(posix(body("cat <<'EOF' | myprog"))).toContain('delete_files');
  });

  it('an interpreter behind a wrapper reads the body as its source', () => {
    const text = [
      "sudo -u builder python3 - <<'EOF'",
      'subprocess.check_call([sys.executable, "-m", "pip", "install", "x"])',
      'EOF',
    ].join(NL);
    expect(
      programSources(text, { direct: true, host: 'posix' }).sources.flatMap((s) =>
        s.kind === 'code' ? [s.language] : [],
      ),
    ).toEqual(['python']);
  });

  it('csh and tcsh are shells everywhere: what they are fed and their -c line', () => {
    for (const shell of ['csh', 'tcsh']) {
      expect(stdinReceiver(`${shell} `, '').kind, shell).toBe('shell');
      expect(staticShellCategories(`${shell} -c "rm -rf build"`, 'posix').sort(), shell).toEqual([
        'delete_files',
        'inline_code',
      ]);
    }
  });

  it('no shell is missing from the readers: every shell runs what it is fed', () => {
    for (const shell of SHELLS) {
      expect(stdinReceiver(`${shell} `, '').kind, shell).toBe('shell');
    }
    for (const program of SHELL_PROGRAMS) {
      expect(stdinReceiver(`${program} `, '').kind, program).not.toBe('data');
    }
  });
});

// Review pass 7 of #683: "data" only for a reader that cannot execute what it
// reads, and an interpreter whose language is not read gets its body judged.
describe('data readers cannot execute, unreadable interpreters are judged (review pass 7 of #683) @cap:executer-une-commande/moteur', () => {
  const NL = String.fromCharCode(10);
  const posix = (cmd: string): string[] => staticShellCategories(cmd, 'posix');

  it('sed and awk can execute what they read: their body is judged', () => {
    expect(posix(["sed e <<'EOF'", 'rm -rf build', 'EOF'].join(NL))).toContain('delete_files');
    expect(
      posix(["awk -f - <<'EOF'", 'BEGIN { system("rm -rf build") }', 'EOF'].join(NL)),
    ).toContain('delete_files');
  });

  it('expect, an interpreter Nodal does not read, has its body judged as commands', () => {
    const text = ["expect <<'EOF'", 'exec rm -rf /', 'EOF'].join(NL);
    expect(posix(text)).toContain('delete_files');
    expect(isCatastrophicCommand(text, 'posix')).toBe(true);
    expect(
      programSources(text, { direct: true, host: 'posix' }).sources.flatMap((s) =>
        s.kind === 'code' ? [s.language] : [],
      ),
    ).toEqual(['shell']);
  });

  it('no data reader can run anything: not a shell, a launcher, an interpreter or an executor', () => {
    const executors = [
      'sed',
      'awk',
      'gawk',
      'mawk',
      'nawk',
      'perl',
      'ruby',
      'find',
      'xargs',
      'vi',
      'vim',
      'nvim',
      'ex',
      'ed',
      'less',
      'more',
      'm4',
      'make',
      'gdb',
      'emacs',
      'nano',
      'man',
    ];
    for (const reader of DATA_CONSUMERS) {
      expect(SHELLS, reader).not.toContain(reader);
      expect(RUNS_ANOTHER_PROGRAMS, reader).not.toContain(reader);
      expect(interpreterKind(reader), reader).toBeNull();
      expect(executors, reader).not.toContain(reader);
    }
  });
});
