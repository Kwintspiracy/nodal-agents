// shell-pass8.test.ts — what the review of PR #682 found at pass 8 (#667, closes #691).
//
// - The help/version excuse ("it prints and exits") excused programs that do
//   not print: a desktop program (`notepad --help`), a document run by name
//   (`report.pdf -h`), a launcher that reaches out. Such a unit is judged by
//   `reachesOut` first, and never counts as a read.
// - PowerShell's iex runs code the text may not hold: `iex $c`, `… | iex` from
//   a command; a LITERAL piped into iex is the code it runs, read as such.
// - VS Code's extension commands change installed software.

import { describe, it, expect } from 'vitest';
import {
  isDestructiveOrHeavyCommand,
  programDecidedAtRunTime,
  staticShellCategories,
} from '../catastrophic-command';

const opensOrSends = (cmd: string, host?: 'windows' | 'posix') =>
  staticShellCategories(cmd, host).includes('open_or_send');

describe('a unit that reaches out is never excused as a help or a version (#667, closes #691) @cap:executer-une-commande/moteur', () => {
  it('a desktop program, a document or a launcher with a help flag still opens a window', () => {
    for (const [cmd, host] of [
      ['notepad --help', 'windows'],
      ['calc -h', 'windows'],
      ['mspaint --version', 'windows'],
      ['report.pdf -h', 'windows'],
      ['cmd /c report.pdf --version', 'windows'],
      ['start /b report.pdf -h', 'windows'],
      ['Start-Process -Verb Print report.txt -ArgumentList --help', 'windows'],
      ['xdg-open --help report.pdf', 'posix'],
      // the launcher prints, even when what it starts only reads its help
      ['Start-Process -Verb Print node -ArgumentList --help', 'windows'],
    ] as const) {
      expect(opensOrSends(cmd, host), cmd).toBe(true);
      expect(isDestructiveOrHeavyCommand(cmd, host), cmd).toBe(true);
    }
  });

  it('a program that prints and exits is still excused', () => {
    for (const cmd of ['code --version', 'xdg-open --version', 'open --help', 'wget --version']) {
      expect(staticShellCategories(cmd), cmd).toEqual([]);
      expect(isDestructiveOrHeavyCommand(cmd), cmd).toBe(false);
    }
  });
});

describe('iex runs code the text may not hold (#667, review of #682 pass 8) @cap:executer-une-commande/moteur', () => {
  it('iex on a variable, an expression or the pipeline of a command is decided at run time', () => {
    for (const [cmd, host] of [
      [`powershell -Command "$c = 'Start-Process -Verb Print report.pdf'; iex $c"`, 'windows'],
      [`pwsh -Command "$c = 'Start-Process -Verb Print report.pdf'; iex $c"`, 'posix'],
      [`powershell -Command "Invoke-Expression -Command $c"`, 'windows'],
      [`powershell -Command "iex (Get-Content x.ps1 -Raw)"`, 'windows'],
      [`powershell -Command "Get-Content x.ps1 | iex"`, 'windows'],
      [`powershell -Command $c`, 'posix'],
    ] as const) {
      expect(programDecidedAtRunTime(cmd, host), cmd).toBe(true);
    }
  });

  it('a literal piped into iex is the code it runs, read for every kind', () => {
    expect(opensOrSends(`powershell -Command "'Start-Process notepad' | iex"`, 'windows')).toBe(
      true,
    );
    expect(
      opensOrSends(`powershell -Command "'Out-Printer -Name Office x' | iex"`, 'windows'),
    ).toBe(true);
    expect(
      staticShellCategories(`powershell -Command "'Remove-Item -Recurse build' | iex"`, 'windows'),
    ).toContain('delete_files');
    // a literal, read: not decided at run time
    expect(programDecidedAtRunTime(`powershell -Command "'Get-Date' | iex"`, 'windows')).toBe(
      false,
    );
    expect(programDecidedAtRunTime(`powershell -Command "iex 'Get-Date'"`, 'windows')).toBe(false);
  });
});

describe('VS Code extensions change installed software (#667, review of #682 pass 8) @cap:executer-une-commande/moteur', () => {
  it('installing, updating or removing an extension is install_software, like a package', () => {
    for (const cmd of [
      'code --install-extension ms-python.python',
      'code --uninstall-extension ms-python.python',
      'code --update-extensions',
      'cursor --install-extension x.y',
      'pip uninstall requests',
      'npm uninstall left-pad',
      'winget uninstall Foo',
    ]) {
      expect(staticShellCategories(cmd), cmd).toEqual(['install_software']);
    }
    expect(staticShellCategories('code --list-extensions')).toEqual([]);
  });
});
