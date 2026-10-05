// shell-cmd-prefix-and-start-values.test.ts — two cmd forms the review of PR #682 found at pass 6 (#667).
//
// - cmd's echo-off prefix `@` (`@lpr x`, `@start x`, `@rm -rf /`) stayed glued to
//   the program word, so nothing recognised the program. In cmd it is a prefix
//   of the command, at its start and after `&`, `&&`, `||`, `(`; never in
//   PowerShell, where `@(`, `@{` and `@args` mean something else.
// - `start /D path`, `/NODE n`, `/AFFINITY hex`, `/MACHINE x` take a value: the
//   value was read as what `start` starts.

import { describe, it, expect } from 'vitest';
import {
  commandUnits,
  isCatastrophicCommand,
  staticShellCategories,
} from '../catastrophic-command';

const opensOrSends = (cmd: string) =>
  staticShellCategories(cmd, 'windows').includes('open_or_send');

describe("cmd's @ prefix and start's switches with a value (#667, review of #682 pass 6) @cap:executer-une-commande/moteur", () => {
  it("@ before a command is cmd's prefix, at the start and after & && || (", () => {
    for (const cmd of [
      '@start report.pdf',
      '@lpr report.pdf',
      '@@lpr report.pdf',
      '@ lpr report.pdf',
      `@powershell -NoProfile -Command "Start-Process 'test-nodal.txt' -Verb Print"`,
      'echo a & @lpr report.pdf',
      'echo a && @lpr report.pdf',
      'echo a || @lpr report.pdf',
      'if exist report.pdf (@lpr report.pdf)',
      'cmd /c @lpr report.pdf',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
    expect(isCatastrophicCommand('@rm -rf /', 'windows')).toBe(true);
    expect(isCatastrophicCommand('echo off & @rd /s /q C:\\', 'windows')).toBe(true);
    expect(commandUnits('@lpr report.pdf', 0, 'cmd')).toEqual([['lpr', 'report.pdf']]);
  });

  it('a quoted @ is text, and PowerShell keeps its @( @{ @args', () => {
    expect(commandUnits('echo "@lpr report.pdf"', 0, 'cmd')).toEqual([['echo', '@lpr report.pdf']]);
    // splatting: `@args` is an argument of Write-Host, never a prefix
    expect(commandUnits('Write-Host @args', 0, 'powershell')).toEqual([['write-host', '@args']]);
    expect(commandUnits('@args', 0, 'powershell')).toEqual([['@args']]);
  });

  it('start /D takes a path, spaced, glued or quoted; /NODE, /AFFINITY, /MACHINE take a value', () => {
    for (const cmd of [
      'start /b /D C:\\work notepad /p report.txt',
      'start /b /D .. report.pdf',
      'start /b /DC:\\work notepad /p report.txt',
      'start /b /D"C:\\my work" notepad /p report.txt',
      'start /b /NODE 1 notepad /p report.txt',
      'start /b /AFFINITY 0x3 notepad /p report.txt',
      'start /b /MACHINE amd64 notepad /p report.txt',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
    // what it starts is the program after the switches and their values
    expect(commandUnits('start /b /D C:\\work node server.js', 0, 'cmd')).toEqual([
      ['start', '/b', '/D', 'C:\\work', 'node', 'server.js'],
      ['node', 'server.js'],
    ]);
    expect(opensOrSends('start /b /D C:\\work node server.js')).toBe(false);
  });
});
