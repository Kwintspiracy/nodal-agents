// read-source.test.ts — the commands a script or a piece of code runs, read
// in its language, with their line (#635).

import { describe, it, expect } from 'vitest';
import { readSource, staticShellCategories, type SourceLanguage } from '../index';

/** Each command a source runs, with its line and the kinds it is filed under. */
function kinds(text: string, language: SourceLanguage): Array<[number, string[]]> {
  return readSource(text, language)
    .commands.map((c): [number, string[]] => [c.line, staticShellCategories(c.command)])
    .filter(([, k]) => k.length > 0);
}

describe('readSource: the commands a source runs, with their line (#635) @cap:executer-une-commande/moteur', () => {
  it('the script of the ticket: pip run by the interpreter itself', () => {
    const script = [
      'import subprocess, sys',
      'try:',
      '    import openpyxl',
      'except ImportError:',
      '    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])',
      'wb = openpyxl.Workbook()',
    ].join('\n');
    expect(kinds(script, 'python')).toEqual([[5, ['install_software']]]);
  });

  it('every way a Python script starts a program', () => {
    const script = [
      'import os, subprocess',
      'os.system("pip install requests")',
      "subprocess.run(['rm', '-rf', build_dir], check=True)",
      'subprocess.run("taskkill /F /IM excel.exe", shell=True)',
      'subprocess.run(',
      '    ["npm",',
      '     "install", "sharp"])',
      'pip.main(["install", "pandas"])',
    ].join('\n');
    expect(kinds(script, 'python')).toEqual([
      [2, ['install_software']],
      [3, ['delete_files']],
      [4, ['stop_programs']],
      [6, ['install_software']],
      [8, ['install_software']],
    ]);
  });

  it('a value decided at run time is a `$`: a download into it is unreadable, not inside', () => {
    const [cmd] = readSource('os.system(f"curl -o {dest} https://x/y")', 'python').commands;
    expect(cmd?.command).toBe('curl -o $ https://x/y');
    const [js] = readSource('execSync(`wget -O ${out} https://x/y`)', 'javascript').commands;
    expect(js?.command).toBe('wget -O $ https://x/y');
    const [list] = readSource(
      'subprocess.run(["git", "clone", url, dest], check=True)',
      'python',
    ).commands;
    expect(list?.command).toBe('git clone $ $ $');
  });

  it('JavaScript, Ruby, Perl and PHP: the strings a program is started with', () => {
    expect(
      kinds(
        [
          "const { execSync, spawn } = require('child_process');",
          'execSync(`npm i ${pkg}`);',
          "spawn('pip',",
          "  ['install', 'x']);",
        ].join('\n'),
        'javascript',
      ),
    ).toEqual([
      [2, ['install_software']],
      [3, ['install_software']],
    ]);
    expect(
      kinds(
        ['system("gem install rails")', '`rm -rf tmp`', 'Gem.install("nokogiri")'].join('\n'),
        'ruby',
      ),
    ).toEqual([
      [1, ['install_software']],
      [2, ['delete_files']],
      [3, ['install_software']],
    ]);
    expect(kinds('system("cpan", "install", "X") ; `kill -9 1234`;', 'perl')).toEqual([
      [1, ['stop_programs']],
    ]);
    expect(kinds('<?php shell_exec("npm install"); `del /s /q out`;', 'php')).toEqual([
      [1, ['install_software']],
      [1, ['delete_files']],
    ]);
  });

  it('shell, cmd and PowerShell sources are read line by line, continuations joined', () => {
    expect(
      kinds(
        ['#!/bin/bash', 'set -e', 'cd out \\', '  && pip install \\', '   x', 'rm tmp'].join('\n'),
        'shell',
      ),
    ).toEqual([
      [3, ['install_software']],
      [6, ['delete_files']],
    ]);
    expect(
      kinds(['@echo off', '@pip install x', 'call npm ci', 'rd /s /q build'].join('\r\n'), 'cmd'),
    ).toEqual([
      [2, ['install_software']],
      // `call` hands over to the program, as `cmd /c` does.
      [3, ['install_software']],
      [4, ['delete_files']],
    ]);
    expect(
      kinds(
        ['Install-Module PSReadLine `', '  -Force', 'Stop-Process -Name excel'].join('\n'),
        'powershell',
      ),
    ).toEqual([
      [1, ['install_software']],
      [3, ['stop_programs']],
    ]);
  });

  it('comments are not read, in any language', () => {
    expect(kinds('# os.system("pip install x")\nprint("done")', 'python')).toEqual([]);
    expect(
      kinds("// execSync('npm i x')\n/* execSync('rm -rf build') */\nconsole.log(1)", 'javascript'),
    ).toEqual([]);
    expect(kinds('# system("gem install x")\nputs 1', 'ruby')).toEqual([]);
    expect(kinds('// exec("npm install");\n# `del x`\necho 1;', 'php')).toEqual([]);
    expect(kinds('# rm -rf build\necho ok', 'shell')).toEqual([]);
    expect(kinds('rem pip install x\r\n:: rd /s /q out\r\necho ok', 'cmd')).toEqual([]);
    expect(kinds('<#\npip install x\n#>\n# Stop-Process x\nWrite-Host ok', 'powershell')).toEqual(
      [],
    );
    expect(kinds('=begin\nsystem("gem install x")\n=end\nputs 1', 'ruby')).toEqual([]);
    expect(kinds('=pod\nsystem("kill 1")\n=cut\nprint 1;', 'perl')).toEqual([]);
  });

  it('a script that only reads and writes its own files runs nothing', () => {
    const script = [
      'import csv, json',
      "rows = list(csv.reader(open('data/ventes.csv', encoding='utf-8')))",
      'print(f"{len(rows)} rows read, install complete")',
      "json.dump(rows, open('out/ventes.json', 'w'))",
    ].join('\n');
    expect(kinds(script, 'python')).toEqual([]);
  });

  // The choice, stated: a string is read whether the script runs it or prints
  // it. Telling one from the other takes following values through the code.
  it('a string that begins with a command is read as one, printed or not; a sentence is not', () => {
    expect(kinds('print("pip install openpyxl")', 'python')).toEqual([[1, ['install_software']]]);
    expect(kinds('print("Run pip install openpyxl first")', 'python')).toEqual([]);
  });
});

// Review pass 1 of #683 (P2): a string is read as its language reads it. The
// sources are built with B, a backslash, so the test file itself carries no
// escape: what is read is the escape as the script holds it.
describe('readSource decodes each language string escapes (review of #683) @cap:executer-une-commande/moteur', () => {
  const B = String.fromCharCode(92);
  const commandOf = (text: string, language: SourceLanguage): string[] =>
    readSource(text, language).commands.map((c) => c.command);
  const install = [[1, ['install_software']]];
  const del = [[1, ['delete_files']]];

  it('Python: hex, octal, u and U escapes; a raw string stays as written', () => {
    expect(kinds(`os.system("pip${B}x20install x")`, 'python')).toEqual(install);
    expect(kinds(`os.system("pip${B}040install x")`, 'python')).toEqual(install);
    expect(kinds(`os.system("pip${B}u0020install x")`, 'python')).toEqual(install);
    expect(kinds(`os.system("pip${B}U00000020install x")`, 'python')).toEqual(install);
    expect(kinds(`os.system(b"rm${B}x20-rf x")`, 'python')).toEqual(del);
    expect(commandOf(`os.system(r"pip${B}x20install x")`, 'python')).toContain(
      `pip${B}x20install x`,
    );
  });

  it('JavaScript: hex, u and u-brace escapes, and a line continuation', () => {
    expect(kinds(`execSync('npm${B}x20i x')`, 'javascript')).toEqual(install);
    expect(kinds(`execSync('npm${B}u{20}i x')`, 'javascript')).toEqual(install);
    expect(
      kinds(
        'execSync(' + String.fromCharCode(96) + `rm${B}u0020-rf x` + String.fromCharCode(96) + ')',
        'javascript',
      ),
    ).toEqual(del);
    expect(
      kinds(`execSync('pip${B}` + String.fromCharCode(10) + ` install x')`, 'javascript'),
    ).toEqual(install);
  });

  it('Ruby, PHP, Perl: double quotes decode; single quotes keep the backslash', () => {
    expect(kinds(`system("gem${B}sinstall rails")`, 'ruby')).toEqual(install);
    expect(kinds(`system("gem${B}x20install rails")`, 'ruby')).toEqual(install);
    expect(kinds(`system('gem${B}x20install rails')`, 'ruby')).toEqual([]);
    expect(kinds(`shell_exec("npm${B}x20install");`, 'php')).toEqual(install);
    expect(kinds(`shell_exec("npm${B}u{20}install");`, 'php')).toEqual(install);
    expect(kinds(`shell_exec('npm${B}x20install');`, 'php')).toEqual([]);
    expect(kinds(`system("rm${B}x{20}-rf x");`, 'perl')).toEqual(del);
    expect(kinds(`system("rm${B}040-rf x");`, 'perl')).toEqual(del);
  });
});
