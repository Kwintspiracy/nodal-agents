// shell-checklist.test.ts — reading a command for the autonomy checklist (#464).
//
// The fixture that matters is the 23/09 command (run 06a949cb → b4b493e8): a
// script the agent had just written, run on four files in Downloads and
// Documents, two of them with a space in their path.

import { describe, it, expect } from 'vitest';
import {
  isDestructiveOrHeavyCommand,
  scriptFilesRun,
  splitShellWords,
  staticShellCategories,
} from '../catastrophic-command';
import {
  DEFAULT_SHELL_POLICY,
  pathWords,
  resolveShellPolicy,
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
      { raw: '../../elsewhere/', kind: 'relative' },
    ]);
    expect(pathWords('echo hi > /etc/motd', 'linux')).toEqual([
      { raw: '/etc/motd', kind: 'absolute' },
    ]);
  });

  it('on Windows, /x is a flag, not a path', () => {
    expect(pathWords('rd /s /q build', 'win32')).toEqual([]);
    expect(pathWords('taskkill /F /PID 42', 'win32')).toEqual([]);
    expect(pathWords('ls /c/Users/kwint', 'win32')).toEqual([
      { raw: '/c/Users/kwint', kind: 'absolute' },
    ]);
  });

  it('a relative path that stays inside says nothing', () => {
    expect(pathWords('python scripts/a.py data/x.csv', 'linux')).toEqual([]);
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
