// shell-grammar.test.ts — where a command ends follows the shell that reads it (#667).
//
// Revue de la PR #682, passe 3. Les frontières de commandes étaient lues avec
// UNE grammaire pour tous les shells : `\"` y échappait un guillemet (règle de
// sh), alors que cmd.exe, qui lit la ligne de `run_command` sous Windows, et
// PowerShell n'ont pas d'échappement par antislash ; et `(`, `)`, `{`, `}`
// n'étaient ni des séparateurs ni des fins de mot, si bien que `(rm` était le
// programme. Une impression, un `del /s /q C:\` passaient sans carte, et le
// plancher catastrophique ne voyait rien. Maintenant : les séparateurs, les
// guillemets et l'échappement suivent le shell qui LIT la ligne (sh, cmd,
// PowerShell) ; les mots d'un programme suivent ses règles d'arguments.

import { describe, it, expect } from 'vitest';
import {
  commandUnits,
  isCatastrophicCommand,
  isInlineInterpreterEvalCommand,
  staticShellCategories,
} from '../catastrophic-command';

const kinds = (cmd: string) => [...staticShellCategories(cmd)].sort();
const opensOrSends = (cmd: string) => staticShellCategories(cmd).includes('open_or_send');
const programs = (cmd: string, shell: 'cmd' | 'sh' | 'powershell') =>
  commandUnits(cmd, 0, shell).map((u) => u[0]);

describe('command boundaries follow the shell that reads the line (#667, review of #682 pass 3) @cap:executer-une-commande/moteur', () => {
  it('cmd and PowerShell have no backslash escape: a quote after a backslash closes the string', () => {
    // run_command runs through cmd.exe on Windows
    expect(opensOrSends('echo "a\\" & notepad /p report.txt & echo done"')).toBe(true);
    expect(opensOrSends('echo "x" & lpr report.pdf & echo "a\\" "b"')).toBe(true);
    expect(opensOrSends('echo "a\\" & lpr report.pdf & echo "b"')).toBe(true);
    expect(isCatastrophicCommand('echo "a\\" & del /s /q C:\\ & echo done"')).toBe(true);
    expect(programs('echo "a\\" & lpr report.pdf & echo done"', 'cmd')).toEqual([
      'echo',
      'lpr',
      'echo',
    ]);
    expect(
      programs(
        'Write-Host "a\\"; Start-Process report.pdf -Verb Print; Write-Host "done"',
        'powershell',
      ),
    ).toEqual(['write-host', 'start-process', 'report.pdf', 'write-host']);
    expect(
      opensOrSends(
        `powershell -Command "Write-Host 'a\\'; Start-Process report.pdf -Verb Print; Write-Host 'done'"`,
      ),
    ).toBe(true);
  });

  it('sh keeps its backslash escape: the same text is one echo there', () => {
    expect(programs('echo "a\\" & lpr report.pdf & echo done"', 'sh')).toEqual(['echo']);
    expect(programs("echo 'a & lpr report.pdf'", 'sh')).toEqual(['echo']);
  });

  it("cmd's quotes are double quotes only; ^ is its escape; ; is no separator there", () => {
    expect(programs("echo 'a & lpr report.pdf'", 'cmd')).toEqual(['echo', 'lpr']);
    expect(programs('echo a ^& lpr report.pdf', 'cmd')).toEqual(['echo']);
    expect(programs('echo "a & lpr report.pdf"', 'cmd')).toEqual(['echo']);
    expect(programs('echo a;lpr report.pdf', 'cmd')).toEqual(['echo']);
    expect(programs('echo a;lpr report.pdf', 'sh')).toEqual(['echo', 'lpr']);
  });

  it('PowerShell: backtick escapes, \'\' and "" double a quote, & starts a command', () => {
    expect(programs('Write-Host "a`"; lpr report.pdf"', 'powershell')).toEqual(['write-host']);
    expect(programs("Write-Host 'it''s'; lpr report.pdf", 'powershell')).toEqual([
      'write-host',
      'lpr',
    ]);
    expect(commandUnits(`Write-Host 'it''s' "say ""hi"""`, 0, 'powershell')).toEqual([
      ['write-host', "it's", 'say "hi"'],
    ]);
    expect(programs('Write-Host "say ""hi"""; lpr report.pdf', 'powershell')).toEqual([
      'write-host',
      'lpr',
    ]);
    // `&` is the call operator: a unit of its own, and what it calls is the program.
    expect(programs("& 'C:\\Windows\\notepad.exe' /p report.txt", 'powershell')).toEqual([
      '&',
      'notepad',
    ]);
  });

  it('( ) { } start a command, glued or spaced, in sh and PowerShell; ( ) in cmd blocks', () => {
    for (const cmd of [
      'bash -c "(xdg-open report.pdf)"',
      'bash -c "( xdg-open report.pdf )"',
      'bash -c "{ lpr report.pdf; }"',
      'bash -c "{lpr report.pdf;}"',
      'powershell -Command "(Start-Process report.pdf -Verb Print)"',
      'powershell -Command "& { Start-Process report.pdf -Verb Print }"',
      '(lpr report.pdf)',
      'if exist report.pdf (lpr report.pdf)',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
    expect(isCatastrophicCommand('bash -c "(rm -rf /)"')).toBe(true);
    expect(isCatastrophicCommand('bash -c "{ rm -rf /; }"')).toBe(true);
    expect(isCatastrophicCommand('if exist C:\\ (rd /s /q C:\\)')).toBe(true);
    expect(kinds('Get-ChildItem | ForEach-Object { Remove-Item $_ }')).toEqual(['delete_files']);
  });

  it('quoted parentheses and braces are text, and code stays inline code only', () => {
    expect(kinds('echo "(not a command)"')).toEqual([]);
    expect(kinds('git log --format="%h (%s) {x}"')).toEqual([]);
    expect(kinds('node -e "if (x) { y() }"')).toEqual(['inline_code']);
    expect(kinds(`python -c "print('start')"`)).toEqual(['inline_code']);
    expect(isInlineInterpreterEvalCommand('python -c "print(1)"')).toBe(true);
    expect(kinds('find . -name "*.tmp" -exec rm {} ;')).toEqual(['delete_files']);
    expect(kinds('echo ${HOME}')).toEqual([]);
  });
});
