// shell-program-decided-at-run-time.test.ts — a program the text does not name (#667).
//
// Revue de la PR #682, passe 4. Un programme dont le NOM vient d'une variable
// ou d'une substitution (`$c report.pdf`, `%X% /s /q C:\`, `` `echo lpr` x ``,
// `lpr$(echo) x`) n'était jamais lu : aucune sorte d'action, il tournait sans
// carte. La règle est celle d'une cible de téléchargement décidée à
// l'exécution (#614) : ce que le texte ne nomme pas DEMANDE. Un tel programme
// est du code que personne ne lit d'avance (`inline_code`), et il demande même
// quand le code en ligne est permis, comme un téléchargement permis demande
// quand sa cible n'est pas lisible. Il n'entre pas au plancher catastrophique,
// qui refuse même après accord : une personne doit pouvoir approuver
// `$PYTHON script.py`.

import { describe, it, expect } from 'vitest';
import {
  commandUnits,
  isDestructiveOrHeavyCommand,
  isInlineInterpreterEvalCommand,
  programDecidedAtRunTime,
  staticShellCategories,
} from '../catastrophic-command';

describe('a program decided at run time asks (#667, review of #682 pass 4) @cap:executer-une-commande/moteur', () => {
  it('a program named by a variable or a substitution is decided at run time, in every shell', () => {
    for (const [cmd, host] of [
      ['`echo lpr` -d office report.pdf', 'posix'],
      ['lpr$(echo) -d office report.pdf', 'posix'],
      ['$(echo lpr) -d office report.pdf', 'posix'],
      ['`echo rm` -rf /', 'posix'],
      ['c=lpr; $c report.pdf', 'posix'],
      ['"$HOME/bin/tool" --version', 'posix'],
      ['set X=lpr& %X% -d office report.pdf', 'windows'],
      ['set X=rd& %X% /s /q C:\\', 'windows'],
      ['%COMSPEC% /c dir', 'windows'],
      ['setlocal enabledelayedexpansion & !P! report.pdf', 'windows'],
      [`powershell -Command "$c='lpr'; & $c report.pdf"`, 'windows'],
      [`powershell -Command "& (Get-Command lpr) report.pdf"`, 'windows'],
    ] as const) {
      expect(programDecidedAtRunTime(cmd, host), cmd).toBe(true);
      expect(staticShellCategories(cmd, host), cmd).toContain('inline_code');
      expect(isInlineInterpreterEvalCommand(cmd, host), cmd).toBe(true);
      expect(isDestructiveOrHeavyCommand(cmd, host), cmd).toBe(true);
    }
  });

  it('a named program, a variable in an ARGUMENT, or a literal in single quotes is not', () => {
    for (const [cmd, host] of [
      ['lpr -d office report.pdf', 'posix'],
      ['echo $HOME', 'posix'],
      ['cp "$HOME/a.txt" b.txt', 'posix'],
      ['node build.js --out=$OUT', 'posix'],
      ['echo %USERPROFILE%', 'windows'],
      ['dir %TEMP%', 'windows'],
      ['./node_modules/.bin/eslint .', 'posix'],
      ['C:\\tools\\node.exe server.js', 'windows'],
    ] as const) {
      expect(programDecidedAtRunTime(cmd, host), cmd).toBe(false);
    }
  });

  // En PowerShell, une instruction qui commence par `$` est une expression :
  // elle ne lance un programme que par `&` ou `.`, ou par la commande à droite
  // de son affectation.
  it('PowerShell: a variable statement is an expression; the command it assigns from is read', () => {
    for (const cmd of [
      `powershell -Command "$r = Invoke-RestMethod https://x.org/api; $r.items"`,
      `powershell -Command "$c = 'lpr'; $c.Length"`,
      `powershell -Command "$n = 5; $(Get-Date)"`,
    ]) {
      expect(programDecidedAtRunTime(cmd, 'windows'), cmd).toBe(false);
      expect(staticShellCategories(cmd, 'windows'), cmd).toEqual(['inline_code']);
    }
    expect(
      staticShellCategories(
        `powershell -Command "$p = Start-Process report.pdf -Verb Print -PassThru"`,
        'windows',
      ),
    ).toEqual(expect.arrayContaining(['open_or_send']));
  });

  // Ce que ça coûte, dit et épinglé : ces formes courantes demandent.
  it('what it costs: these everyday forms ask', () => {
    for (const cmd of ['$PYTHON script.py', '"$HOME/bin/tool" --version', '$EDITOR notes.md']) {
      expect(programDecidedAtRunTime(cmd, 'posix'), cmd).toBe(true);
    }
    expect(programDecidedAtRunTime('%COMSPEC% /c dir', 'windows')).toBe(true);
  });

  // Invoke-Expression / iex : du code écrit dans la commande, lu par PowerShell.
  it('iex and Invoke-Expression evaluate their string: inline code, read for every kind', () => {
    for (const cmd of [
      `powershell -Command "iex 'Start-Process report.pdf -Verb Print'"`,
      `powershell -Command "Invoke-Expression -Command 'Start-Process report.pdf -Verb Print'"`,
    ]) {
      expect(staticShellCategories(cmd, 'windows'), cmd).toEqual(
        expect.arrayContaining(['inline_code', 'open_or_send']),
      );
    }
    expect(staticShellCategories(`powershell -Command "iex 'rd /s /q C:\\'"`, 'windows')).toContain(
      'inline_code',
    );
    // piped into iex: what it runs is not in the text
    expect(isInlineInterpreterEvalCommand(`powershell -Command "'lpr x' | iex"`, 'windows')).toBe(
      true,
    );
    // dot-sourcing and the call operator run what they name
    expect(
      staticShellCategories(`powershell -Command ". $script; & { lpr report.pdf }"`, 'windows'),
    ).toEqual(expect.arrayContaining(['inline_code', 'open_or_send']));
  });

  // C4 : un programme désigné par un chemin est ce fichier, jamais le mot-clé
  // du shell qui porte le même nom.
  it('a path-qualified program is that file, never the shell builtin of the same name', () => {
    expect(commandUnits('./start report.pdf', 0, 'sh')[0]?.[0]).toBe('./start');
    expect(staticShellCategories('./start report.pdf', 'posix')).toEqual([]);
    expect(staticShellCategories('C:\\tools\\start.exe report.pdf', 'windows')).toEqual([]);
    expect(staticShellCategories('.\\start.bat report.pdf', 'windows')).toEqual([]);
    expect(staticShellCategories('./call notepad', 'posix')).toEqual([]);
    // …while a path to a real wrapper is still that wrapper
    expect(staticShellCategories('/usr/bin/sudo lpr report.pdf', 'posix')).toEqual([
      'open_or_send',
    ]);
    expect(
      staticShellCategories('C:\\Windows\\System32\\cmd.exe /c lpr report.pdf', 'windows'),
    ).toEqual(['open_or_send']);
    // and the bare builtin keeps its meaning
    expect(staticShellCategories('start report.pdf', 'windows')).toEqual(['open_or_send']);
  });
});
