// shell-checklist.test.ts — reading a command for the autonomy checklist (#464).
//
// The fixture that matters is the 23/09 command (run 06a949cb → b4b493e8): a
// script the agent had just written, run on four files in Downloads and
// Documents, two of them with a space in their path.

import { describe, it, expect } from 'vitest';
import {
  codeActionCategories,
  isDestructiveOrHeavyCommand,
  scriptFilesRun,
  splitShellWords,
  staticShellCategories,
} from '../catastrophic-command';
import {
  DEFAULT_SHELL_POLICY,
  pathWords,
  resolveShellPolicy,
  scriptPathLiterals,
  SHELL_CATEGORIES,
} from '../shell-checklist';

const SCRIPT =
  'C:/Users/kwint/.nodalai/workspaces/00000000-0000-0000-0000-000000000002/shared/scripts/_analyze_gains_file.py';
const COMMAND_23_09 =
  `python "${SCRIPT}" "C:/Users/kwint/Downloads/earnings_2026_statement.csv" ` +
  '"C:/Users/kwint/Downloads/sales-2026-08.csv" ' +
  '"C:/Users/kwint/Documents/RevenusMF/Earnings_MF- 2026_updated.xlsx" ' +
  '"C:/Users/kwint/Documents/RevenusMF/Cults/sales-2026-01.csv"';

describe('splitShellWords @cap:executer-une-commande/moteur', () => {
  it('keeps a quoted path with a space as one word, and cuts on && and pipes', () => {
    expect(splitShellWords('python a.py "C:/My Files/x.csv" && cat y | grep z > out.txt')).toEqual([
      ['python', 'a.py', 'C:/My Files/x.csv'],
      ['cat', 'y'],
      ['grep', 'z', 'out.txt'],
    ]);
  });
});

describe('staticShellCategories @cap:executer-une-commande/moteur', () => {
  it('names the kind of each heavy action', () => {
    expect(staticShellCategories('rm -rf build')).toEqual(['delete_files']);
    expect(staticShellCategories('Remove-Item x.txt')).toEqual(['delete_files']);
    expect(staticShellCategories('pip install pandas')).toEqual(['install_software']);
    expect(staticShellCategories('wget https://example.com/a.zip')).toEqual(['download']);
    expect(staticShellCategories('taskkill /F /PID 42')).toEqual(['stop_programs']);
    expect(staticShellCategories('icacls C:\\data /grant x:F')).toEqual(['system_settings']);
    expect(staticShellCategories('python -c "print(1)"')).toEqual(['own_script']);
    expect(staticShellCategories('ls -la && git status')).toEqual([]);
  });

  it('covers exactly what destructive_gate has always gated', () => {
    const heavy = [
      'rm x',
      'npm install left-pad',
      'git clone https://x/y',
      'kill 12',
      'diskpart',
      'git reset --hard',
      'node -e "1"',
    ];
    for (const cmd of heavy) {
      expect(isDestructiveOrHeavyCommand(cmd)).toBe(true);
      expect(staticShellCategories(cmd).length).toBeGreaterThan(0);
    }
  });
});

describe('scriptFilesRun @cap:executer-une-commande/moteur', () => {
  it('reads the script an interpreter runs, even quoted with its full path', () => {
    expect(scriptFilesRun(COMMAND_23_09)).toEqual([SCRIPT]);
  });

  it('reads direct scripts and PowerShell -File, not flags, inline code or modules', () => {
    expect(scriptFilesRun('./build.sh --fast')).toEqual(['./build.sh']);
    expect(scriptFilesRun('powershell -ExecutionPolicy Bypass -File tools/fix.ps1')).toEqual([
      'tools/fix.ps1',
    ]);
    expect(scriptFilesRun('python -u run.py')).toEqual(['run.py']);
    expect(scriptFilesRun('python -m pytest tests')).toEqual([]);
    expect(scriptFilesRun('node -e "console.log(1)"')).toEqual([]);
    expect(scriptFilesRun('git status')).toEqual([]);
  });
});

describe('pathWords @cap:executer-une-commande/moteur', () => {
  it('finds the four data files of 23/09 (the program running them is not one)', () => {
    const words = pathWords(COMMAND_23_09, 'win32').map((w) => w.raw);
    expect(words).toEqual([
      SCRIPT,
      'C:/Users/kwint/Downloads/earnings_2026_statement.csv',
      'C:/Users/kwint/Downloads/sales-2026-08.csv',
      'C:/Users/kwint/Documents/RevenusMF/Earnings_MF- 2026_updated.xlsx',
      'C:/Users/kwint/Documents/RevenusMF/Cults/sales-2026-01.csv',
    ]);
  });

  it('the null device is not a path: 2>nul, > /dev/null, > $null', () => {
    // Revue de la PR #474 : Reviewer C a lancé `dir /b x 2>nul` ; `nul` était
    // lu comme un chemin relatif, que Windows résout en `\\.\nul`, hors des
    // dossiers : une question pour une commande qui n'écrit nulle part.
    const words = (cmd: string, platform: string) => pathWords(cmd, platform).map((w) => w.raw);
    const nullDevice = /^(nul:?|\/dev\/null|\$null)$/i;
    for (const [cmd, platform, path] of [
      ['dir /b packages 2>nul', 'win32', 'packages'],
      ['dir /b packages >NUL 2>&1', 'win32', 'packages'],
      ['ls src > /dev/null 2>&1', 'linux', 'src'],
      ['Get-Item src > $null', 'win32', 'src'],
    ] as const) {
      expect(words(cmd, platform), cmd).toContain(path);
      expect(
        words(cmd, platform).filter((w) => nullDevice.test(w)),
        cmd,
      ).toEqual([]);
    }
    // Un vrai fichier qui s'appellerait « nullable » reste un chemin.
    expect(pathWords('cat nullable', 'linux').map((w) => w.raw)).toEqual(['nullable']);
  });

  it('reads option values, home paths, climbing relatives and redirections', () => {
    expect(pathWords('tool --out=C:\\tmp\\x.txt', 'win32')).toEqual([
      { raw: 'C:\\tmp\\x.txt', kind: 'absolute' },
    ]);
    expect(pathWords('cat ~/.ssh/id_rsa', 'linux')).toEqual([
      { raw: '~/.ssh/id_rsa', kind: 'home' },
    ]);
    expect(pathWords('type %USERPROFILE%\\notes.txt', 'win32')).toEqual([
      { raw: '%USERPROFILE%\\notes.txt', kind: 'home' },
    ]);
    expect(pathWords('cp a.txt ../../elsewhere/', 'linux')).toEqual([
      { raw: 'a.txt', kind: 'relative' },
      { raw: '../../elsewhere/', kind: 'relative' },
    ]);
    expect(pathWords('echo hi > /etc/motd', 'linux')).toEqual([
      { raw: 'hi', kind: 'relative' },
      { raw: '/etc/motd', kind: 'absolute' },
    ]);
  });

  it('on Windows, /x is a flag, not a path', () => {
    expect(pathWords('rd /s /q build', 'win32')).toEqual([{ raw: 'build', kind: 'relative' }]);
    expect(pathWords('taskkill /F /PID 42', 'win32')).toEqual([{ raw: '42', kind: 'relative' }]);
    expect(pathWords('ls /c/Users/kwint', 'win32')).toEqual([
      { raw: '/c/Users/kwint', kind: 'absolute' },
    ]);
  });

  it('every other word is a relative candidate, for the gate to resolve (a symlink never climbs)', () => {
    expect(pathWords('cat link/secret', 'linux')).toEqual([
      { raw: 'link/secret', kind: 'relative' },
    ]);
    expect(pathWords('python scripts/a.py data/x.csv', 'linux')).toEqual([
      { raw: 'scripts/a.py', kind: 'relative' },
      { raw: 'data/x.csv', kind: 'relative' },
    ]);
  });

  it('options and URLs are not paths', () => {
    expect(pathWords('git clone --depth 1 https://github.com/x/y', 'linux')).toEqual([
      { raw: 'clone', kind: 'relative' },
      { raw: '1', kind: 'relative' },
    ]);
  });
});

describe('resolveShellPolicy @cap:executer-une-commande/moteur', () => {
  it('asks for everything when nothing is stored', () => {
    expect(resolveShellPolicy(null)).toEqual(DEFAULT_SHELL_POLICY);
    expect(SHELL_CATEGORIES.every((c) => DEFAULT_SHELL_POLICY[c] === 'ask')).toBe(true);
  });

  it('keeps what was set and defaults the rest', () => {
    expect(resolveShellPolicy({ delete_files: 'never', download: 'allow' })).toEqual({
      ...DEFAULT_SHELL_POLICY,
      delete_files: 'never',
      download: 'allow',
    });
  });

  it('refuses a stored value it cannot read, instead of guessing', () => {
    expect(() => resolveShellPolicy({ delete_files: 'maybe' })).toThrow();
    expect(() => resolveShellPolicy({ format_disk: 'never' })).toThrow();
  });
});

describe('review of PR #474 (Reviewer A): the program that runs, not a word of the text @cap:executer-une-commande/moteur', () => {
  const kinds = (cmd: string) => [...staticShellCategories(cmd)].sort();

  it('a MENTION in an argument is not the action (P1, false red)', () => {
    expect(kinds('git commit -m "rm old refs"')).toEqual([]);
    expect(kinds('echo "please rm the temp file"')).toEqual([]);
    expect(kinds('clang-format -i src.ts')).toEqual([]);
    expect(kinds('git format-patch -1')).toEqual([]);
  });

  it('the action is still read where the shell runs it: wrappers, substitutions, paths', () => {
    for (const cmd of [
      'rm -rf build',
      '/bin/rm -rf build',
      'sudo rm -rf build',
      'bash -c "rm -rf build"',
      'cmd /c del build.txt',
      'powershell -Command "Remove-Item build -Recurse"',
      'find . -name "*.tmp" -exec rm {} \\;',
      'ls | xargs rm',
      'echo $(rm -rf build)',
      'r""m -rf build',
    ]) {
      expect(kinds(cmd), cmd).toContain('delete_files');
    }
  });

  it('closes the list gaps: npm i, pnpm add, curl > file, chmod, chown, net stop (P1)', () => {
    expect(kinds('npm i express')).toContain('install_software');
    expect(kinds('pnpm add lodash')).toContain('install_software');
    expect(kinds('yarn add left-pad')).toContain('install_software');
    expect(kinds('curl https://example.com/dump.zip > dump.zip')).toContain('download');
    expect(kinds('curl https://example.com/dump.zip --output dump.zip')).toContain('download');
    expect(kinds('chmod 666 secret.txt')).toContain('system_settings');
    expect(kinds('chown root secret.txt')).toContain('system_settings');
    expect(kinds('net stop Spooler')).toContain('stop_programs');
    // A plain read of a URL is not a download to disk.
    expect(kinds('curl https://example.com/status')).toEqual([]);
  });

  it('inline code is read for what its interpreter API does (P1)', () => {
    expect(kinds(`python -c "import shutil; shutil.rmtree('build')"`)).toEqual([
      'delete_files',
      'own_script',
    ]);
    expect(kinds(`node -e "require('fs').rmSync('x', { recursive: true })"`)).toContain(
      'delete_files',
    );
    expect(kinds(`python -c "import os; os.remove('report.pdf')"`)).toContain('delete_files');
    expect(
      codeActionCategories("import urllib.request\nurllib.request.urlretrieve(u, 'x.zip')"),
    ).toEqual(['download']);
    expect(codeActionCategories('print("hello")')).toEqual([]);
  });

  it('a program named by a relative path is a path; a system program by its absolute path is not (P2)', () => {
    expect(pathWords('../Downloads/evil.exe report.xlsx', 'win32').map((w) => w.raw)).toContain(
      '../Downloads/evil.exe',
    );
    expect(
      pathWords('C:\\Python311\\python.exe tools/x.py', 'win32').map((w) => w.raw),
    ).not.toContain('C:\\Python311\\python.exe');
  });
});

describe('what the shell will do to a word (Codex review of #464, pass 2) @cap:executer-une-commande/moteur', () => {
  it('reads a split or escaped command word as the program it runs', () => {
    expect(staticShellCategories('r""m -rf ./build')).toEqual(['delete_files']);
    expect(staticShellCategories('r^m -rf ./build')).toEqual(['delete_files']);
  });

  it('marks a path the shell builds by expansion as unresolved, the home folder excepted', () => {
    expect(pathWords('cat "${SECRET}/id_rsa"', 'linux')).toEqual([
      { raw: '${SECRET}/id_rsa', kind: 'unresolved' },
    ]);
    expect(pathWords('cat $(printf /etc/passwd)', 'linux')[0]).toEqual({
      raw: '$(printf',
      kind: 'unresolved',
    });
    expect(pathWords('cat "${HOME}/.ssh/id_rsa"', 'linux')).toEqual([
      { raw: '${HOME}/.ssh/id_rsa', kind: 'home' },
    ]);
    // Single quotes do not expand: awk's $1 is not a path the shell builds.
    expect(pathWords("awk '{print $1}' data.csv", 'linux')).toEqual([
      { raw: '{print $1}', kind: 'relative' },
      { raw: 'data.csv', kind: 'relative' },
    ]);
  });
});

describe("scriptPathLiterals: the paths a script names (Quentin's test, 24/09) @cap:executer-une-commande/moteur", () => {
  it('finds absolute and home paths in string literals, not routes or relative strings', () => {
    const source = [
      'PATH = r"C:/Users/kwint/Downloads/Exports_Generation_20260915_072934.xlsx"',
      "OUT = '/home/q/report.csv'",
      'KEY = "~/.ssh/id_rsa"',
      'API = "/api/v1/users"',
      'NAME = "data/x.csv"',
      'URL = "https://example.com/a"',
    ].join('\n');
    expect(scriptPathLiterals(source, 'linux')).toEqual([
      { raw: 'C:/Users/kwint/Downloads/Exports_Generation_20260915_072934.xlsx', kind: 'absolute' },
      { raw: '/home/q/report.csv', kind: 'absolute' },
      { raw: '~/.ssh/id_rsa', kind: 'home' },
    ]);
  });

  it('reads escaped Windows paths as the path they spell', () => {
    expect(
      scriptPathLiterals('p = "C:\\\\Users\\\\kwint\\\\Documents\\\\a.xlsx"', 'win32'),
    ).toEqual([{ raw: 'C:\\Users\\kwint\\Documents\\a.xlsx', kind: 'absolute' }]);
  });
});
