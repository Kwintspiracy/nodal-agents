// program-sources.test.ts — where the code a command runs is: a file it hands
// to an interpreter or runs directly, or code written into it (#635).

import { describe, it, expect } from 'vitest';
import {
  languageOfPath,
  languageOfShebang,
  programSources,
  staticShellCategories,
  type ProgramSource,
  type SourceLanguage,
} from '../index';

/** The files and code a command runs, without the bookkeeping. */
function sources(cmd: string, direct = true): Array<Partial<ProgramSource>> {
  return programSources(cmd, { direct }).sources.map((s) =>
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
    // A file an interpreter or a shell reads is source, not a program.
    expect(programSources('python x.py').sources[0]).toMatchObject({ executed: false });
    expect(programSources('source ./env.sh').sources[0]).toMatchObject({ executed: false });
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
