// powershell-parameters.test.ts — PowerShell parameters read the way
// PowerShell binds them, by the floor and by the shell checklist (#694).
//
// `Remove-Item -Recurse -Fo C:\` passed the catastrophic floor while
// `-Force` did not: PowerShell binds any prefix of a parameter's name, an
// alias, a value glued with `:`, after any of its dashes. Each place that
// reads a PowerShell parameter is pinned here on its abbreviated and full
// spellings, and on what must NOT count (`-Force:$false`).

import { describe, it, expect } from 'vitest';
import {
  downloadWrites,
  isCatastrophicCommand,
  isInlineInterpreterEvalCommand,
  staticShellCategories,
  type ShellHost,
} from '../catastrophic-command';
import { programSources } from '../program-sources';
import {
  POWERSHELL_CLI,
  REMOVE_ITEM,
  START_PROCESS,
  bindPsArguments,
  psParameterNames,
  psSwitch,
} from '../powershell-parameters';

const HOSTS: Array<ShellHost | undefined> = ['windows', 'posix', undefined];

describe('psParameterNames: one word, as PowerShell binds it @cap:executer-une-commande/moteur', () => {
  it.each([
    // full name, any case
    ['-Force', ['force']],
    ['-FORCE', ['force']],
    ['-force', ['force']],
    // every unambiguous prefix
    ['-Fo', ['force']],
    ['-For', ['force']],
    ['-Forc', ['force']],
    ['-Rec', ['recurse']],
    ['-r', ['recurse']],
    // an alias, exact (wins over a prefix of another name)
    ['-cf', ['confirm']],
    ['-LP', ['literalpath']],
    ['-PSPath', ['literalpath']],
    ['-wi', ['whatif']],
    // the other dashes PowerShell takes
    ['\u2013Force', ['force']],
    ['\u2014Recurse', ['recurse']],
    ['\u2015Fo', ['force']],
    // a glued value names the same parameter
    ['-Force:$false', ['force']],
    ['-Fo:$true', ['force']],
  ])('%s binds %j on Remove-Item', (word, names) => {
    expect(psParameterNames(word, REMOVE_ITEM)).toEqual(names);
  });

  it('an ambiguous prefix counts as each parameter it could bind (PowerShell runs nothing)', () => {
    expect(psParameterNames('-f', REMOVE_ITEM)?.sort()).toEqual(['filter', 'force']);
    expect(psParameterNames('-Ver', START_PROCESS)?.sort()).toEqual(['verb', 'verbose']);
  });

  it('a word that is not a parameter word is null; an unknown name binds nothing', () => {
    for (const word of ['C:\\', '-', '--', '-5', '/s', 'Force']) {
      expect(psParameterNames(word, REMOVE_ITEM), word).toBeNull();
    }
    expect(psParameterNames('-Bogus', REMOVE_ITEM)).toEqual([]);
  });

  it('the powershell CLI takes `/`, a doubled dash and its own aliases, and no `:` value', () => {
    expect(psParameterNames('-c', POWERSHELL_CLI)).toEqual(['command']);
    expect(psParameterNames('/c', POWERSHELL_CLI)).toEqual(['command']);
    expect(psParameterNames('--command', POWERSHELL_CLI)).toEqual(['command']);
    expect(psParameterNames('-Comm', POWERSHELL_CLI)).toEqual(['command']);
    expect(psParameterNames('-e', POWERSHELL_CLI)).toEqual(['encodedcommand']);
    expect(psParameterNames('-ec', POWERSHELL_CLI)).toEqual(['encodedcommand']);
    expect(psParameterNames('-ex', POWERSHELL_CLI)).toEqual(['executionpolicy']);
    expect(psParameterNames('-Fil', POWERSHELL_CLI)).toEqual(['file']);
    expect(psParameterNames('/c', REMOVE_ITEM)).toBeNull();
  });
});

describe('psSwitch: a switch set, cleared, or decided at run time @cap:executer-une-commande/moteur', () => {
  const state = (words: string) =>
    psSwitch(bindPsArguments(words.split(' '), REMOVE_ITEM), 'force');
  it.each([
    ['-Force', true],
    ['-Fo', true],
    ['-Force:$true', true],
    ['-Force:1', true],
    ['-Force: $true', true],
    ['-Force:$false', false],
    ['-Force:$FALSE', false],
    ['-Force:0', false],
    ['-Force: $false', false],
    ['-Recurse', false],
    ['C:\\x', false],
    ['-Force:$f', null],
    ['@params', null],
  ])('%s → %s', (words, expected) => {
    expect(state(words)).toBe(expected);
  });

  it('`--` ends the parameters: what follows is positional', () => {
    expect(state('-- -Force')).toBe(false);
  });
});

describe('the floor reads Remove-Item as PowerShell binds it (#694) @cap:executer-une-commande/moteur', () => {
  const programs = ['Remove-Item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'];
  const recurse = [
    '-Recurse',
    '-RECURSE',
    '-Rec',
    '-r',
    '\u2013Recurse',
    '-Recurse:$true',
    '-Recurse: $true',
  ];
  const force = [
    '-Force',
    '-force',
    '-Fo',
    '-For',
    '-Forc',
    '-f',
    '\u2014Force',
    '-Force:$true',
    '-Force:1',
    '-Fo:$true',
  ];

  it('every guarded program, every spelling of -Recurse and -Force, on a drive root', () => {
    for (const program of programs)
      for (const r of recurse)
        for (const f of force)
          for (const host of HOSTS) {
            const cmd = `${program} ${r} ${f} C:\\`;
            expect(isCatastrophicCommand(cmd, host), `${cmd} (${host})`).toBe(true);
          }
  });

  it('the ticket: `Remove-Item -Recurse -Fo C:\\`, and the parameters in any order', () => {
    expect(isCatastrophicCommand('Remove-Item -Recurse -Fo C:\\', 'windows')).toBe(true);
    expect(isCatastrophicCommand('Remove-Item C:\\ -Fo -Rec', 'windows')).toBe(true);
    expect(isCatastrophicCommand('Remove-Item -Path C:\\* -Forc -Re', 'windows')).toBe(true);
  });

  it('a splat may set both switches: it asks', () => {
    expect(isCatastrophicCommand('Remove-Item @opts C:\\', 'windows')).toBe(true);
  });

  it('through every wrapper the floor already sees through', () => {
    for (const cmd of [
      'powershell -Command "Remove-Item -Recurse -Fo C:\\"',
      'powershell -NoProfile -c "ri -r -Fo C:\\"',
      'pwsh /c "Remove-Item -Rec -Force:$true C:\\"',
      'pwsh --command "del -r -Fo C:\\"',
      'cmd /c powershell -Comm "rm -Recurse -Fo C:\\"',
      'powershell -Command "iex \'Remove-Item -Recurse -Fo C:\\\'"',
      'powershell -Command "iex \u2013Command \'Remove-Item -Recurse -Fo C:\\\'"',
    ]) {
      expect(isCatastrophicCommand(cmd, 'windows'), cmd).toBe(true);
    }
  });

  it('a switch cleared with `:$false` or `:0` sets nothing', () => {
    for (const program of programs)
      for (const cmd of [
        `${program} -Recurse -Force:$false C:\\`,
        `${program} -Recurse:$false -Force C:\\`,
        `${program} -Rec -Fo:0 C:\\`,
        `${program} -Recurse: $false -Fo C:\\`,
      ]) {
        expect(isCatastrophicCommand(cmd, 'windows'), cmd).toBe(false);
      }
  });

  it('still only a machine-wide target: a project folder or one switch is not the floor', () => {
    for (const cmd of [
      'Remove-Item .\\build -Recurse -Fo',
      'ri build -r -Fo',
      'Remove-Item -Fo C:\\',
      'Remove-Item -Rec C:\\',
      'Remove-Item -Recurse -WhatIf C:\\',
    ]) {
      expect(isCatastrophicCommand(cmd, 'windows'), cmd).toBe(false);
    }
  });

  it("rm's own options, abbreviated as getopt allows, and grouped", () => {
    for (const cmd of [
      'rm -rf /',
      'rm -fr /',
      'rm -Rfv /',
      'rm -r -f /',
      'rm --recursive --force /',
      'rm --rec --for /',
      'rm --r --f /',
    ]) {
      expect(isCatastrophicCommand(cmd, 'posix'), cmd).toBe(true);
    }
    expect(isCatastrophicCommand('rm -r /', 'posix')).toBe(false);
    expect(isCatastrophicCommand('rm -rf ./build', 'posix')).toBe(false);
  });
});

describe('Start-Process read as PowerShell binds it (open_or_send, #694) @cap:executer-une-commande/moteur', () => {
  const opens = (cmd: string) => staticShellCategories(cmd, 'windows').includes('open_or_send');

  it('a document handed by -FilePath, its prefix, its alias or another dash opens, window or not', () => {
    for (const cmd of [
      'Start-Process -FilePath report.pdf -WindowStyle Hidden',
      'Start-Process -f report.pdf -WindowStyle Hidden',
      'Start-Process -Path report.pdf -WindowStyle Hidden',
      'Start-Process -PSPath report.pdf -WindowStyle Hidden',
      'Start-Process \u2013FilePath report.pdf -WindowStyle Hidden',
      'Start-Process -FilePath:report.pdf -Win Hidden',
    ]) {
      expect(opens(cmd), cmd).toBe(true);
    }
  });

  it('a shell verb, under any spelling, is a desktop action', () => {
    for (const cmd of [
      'Start-Process -Verb Print x.txt -WindowStyle Hidden',
      'Start-Process \u2013Verb Print x.txt -WindowStyle Hidden',
      'Start-Process -Verb:Print x.txt -WindowStyle Hidden',
      'Start-Process -Ver Print x.txt -WindowStyle Hidden',
    ]) {
      expect(opens(cmd), cmd).toBe(true);
    }
  });

  it('a window kept away by any spelling of -NoNewWindow or -WindowStyle Hidden: no open', () => {
    for (const cmd of [
      'Start-Process node -ArgumentList server.js -NoNewWindow',
      'Start-Process node -ArgumentList server.js -n',
      'Start-Process node -ArgumentList server.js -nnw',
      'Start-Process node -Args server.js -NoNew',
      'Start-Process node -ArgumentList server.js -NoNewWindow:$true',
      'Start-Process node -ArgumentList server.js -WindowS Hidden',
      'Start-Process node -ArgumentList server.js \u2013WindowStyle Hidden',
    ]) {
      expect(opens(cmd), cmd).toBe(false);
    }
  });

  it('a window not surely kept away opens', () => {
    for (const cmd of [
      'Start-Process node -ArgumentList server.js -NoNewWindow:$false',
      'Start-Process node -ArgumentList server.js -NoNewWindow:$x',
      'Start-Process node -ArgumentList server.js -WindowStyle Normal',
    ]) {
      expect(opens(cmd), cmd).toBe(true);
    }
  });
});

describe('where a PowerShell line writes, read as PowerShell binds it (#694) @cap:executer-une-commande/moteur', () => {
  const targets = (cmd: string) => downloadWrites(cmd, 'windows').targets.map((t) => t.path);
  // A PowerShell line: on a cmd line, `Set-Location` would be a name cmd
  // looks for in the folder (#717).
  const dirs = (cmd: string) => downloadWrites(cmd, 'windows', 'powershell').dirs;

  it.each([
    ['iwr https://x/a -OutFile C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a -OutF C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a \u2013OutFile C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a -OutFile: C:\\out\\a', ['C:\\out\\a']],
    ['Invoke-WebRequest https://x/a -outfile:C:\\out\\a', ['C:\\out\\a']],
    ['Start-BitsTransfer -Source https://x/a \u2013Destination C:\\out\\a', ['C:\\out\\a']],
    ['Start-BitsTransfer -Source https://x/a -Dest C:\\out\\a', ['C:\\out\\a']],
  ])('%s writes %j', (cmd, expected) => {
    expect(targets(cmd)).toEqual(expected);
  });

  it.each([
    ['iwr https://x/a | Out-File -Encoding utf8 -Fi C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a | Out-File -Encoding utf8 C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a | Set-Content -Encoding utf8 C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a | Add-Content -LP C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a | Tee-Object -Pa C:\\out\\a', ['C:\\out\\a']],
    ['iwr https://x/a | Out-File \u2013FilePath C:\\out\\a', ['C:\\out\\a']],
    // a parameter the cmdlet does not have hides which word is the path: it asks
    ['iwr https://x/a | Out-File -Bogus C:\\out\\a', [null]],
  ])('%s writes %j', (cmd, expected) => {
    expect(targets(cmd)).toEqual(expected);
  });

  it.each([
    ['Set-Location -Path D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['Set-Location -Pat D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['Set-Location -StackName s D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['sl -Path:D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['Push-Location -LP D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['cd -Path D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['cd \u2013Path D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    // sh's and cmd's forms keep their reading
    ['cd -P D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['cd /d D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['cd D:\\x; iwr https://x -OutFile a', ['D:\\x']],
    ['cd -; iwr https://x -OutFile a', [null]],
  ])('%s moves into %j', (cmd, expected) => {
    expect(dirs(cmd)).toEqual(expected);
  });
});

describe('the powershell CLI read as it binds its words (#694) @cap:executer-une-commande/moteur', () => {
  it('-Command and -EncodedCommand, under every spelling, are inline code', () => {
    for (const cmd of [
      'powershell -Command Get-Date',
      'powershell -c Get-Date',
      'pwsh -co Get-Date',
      'powershell -Comm Get-Date',
      'powershell /c Get-Date',
      'pwsh --command Get-Date',
      'powershell \u2013Command Get-Date',
      'powershell -e RwBlAHQALQBEAGEAdABlAA==',
      'powershell -ec RwBlAHQALQBEAGEAdABlAA==',
      'powershell -EncodedCommand RwBlAHQALQBEAGEAdABlAA==',
      'powershell -NoP -W Hidden -c Get-Date',
    ]) {
      for (const host of HOSTS)
        expect(isInlineInterpreterEvalCommand(cmd, host), `${cmd} (${host})`).toBe(true);
    }
  });

  it('a script file is not inline code', () => {
    for (const cmd of [
      'powershell -File x.ps1',
      'powershell -ExecutionPolicy Bypass -File x.ps1',
      'pwsh x.ps1',
    ]) {
      expect(isInlineInterpreterEvalCommand(cmd, 'windows'), cmd).toBe(false);
    }
  });

  // What the powershell CLI runs; `powershell` itself is a name cmd looks
  // for in the folder first (#717), not what this reading is about.
  const scripts = (cmd: string) =>
    programSources(cmd, { direct: true, host: 'windows' })
      .sources.filter((s) => s.kind === 'code' || s.extensions === undefined)
      .map((s) => (s.kind === 'file' ? s.path : `code:${s.code}`));

  it.each([
    ['powershell -File x.ps1', ['x.ps1']],
    ['powershell -Fi x.ps1', ['x.ps1']],
    ['pwsh /f x.ps1', ['x.ps1']],
    ['pwsh --file x.ps1', ['x.ps1']],
    ['powershell -ExecutionPol Bypass -Fil x.ps1', ['x.ps1']],
    ['powershell -ExecutionPol Bypass x.ps1', ['x.ps1']],
    ['powershell -WindowS Hidden -NoProf x.ps1', ['x.ps1']],
    // the script takes every word after it, a -Command among them
    ['powershell -File x.ps1 -Command y', ['x.ps1']],
    ['powershell -- x.ps1', ['x.ps1']],
    // Windows PowerShell runs a first word that is not a script as a command
    ['powershell -ExecutionPol Bypass Get-Date', ['code:Get-Date']],
  ])('%s runs %j', (cmd, expected) => {
    expect(scripts(cmd)).toEqual(expected);
  });

  it('-Command, under any spelling, is a command line read by commandUnits, not a source', () => {
    for (const cmd of ['powershell -co Get-Date', 'pwsh /c Get-Date', 'powershell -ec AAAA']) {
      expect(scripts(cmd), cmd).toEqual([]);
    }
  });
});
