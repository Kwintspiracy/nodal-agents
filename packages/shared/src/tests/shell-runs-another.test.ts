// shell-runs-another.test.ts — what a program that runs another one runs (#667).
//
// Revue de la PR #682, passe 2 : `commandUnits` ne déballait qu'une poignée
// d'enveloppes, chacune avec sa règle. `wsl lpr x`, `timeout 5 xdg-open x`,
// `nohup xdg-open x`, `cmd /q /c start "" x` imprimaient ou ouvraient sans
// carte, et un `cmd /c start` lu dans une ligne PowerShell perdait la règle du
// titre de `start`, au point qu'un `rm` lancé ainsi n'était plus une
// suppression. Un seul mécanisme maintenant : chaque programme dont le but est
// d'en lancer un autre (`SHELL_PROGRAMS`, shell-programs.ts) a sa grammaire
// d'options, et ce qu'il lance est lu par le shell de CETTE enveloppe.

import { describe, it, expect } from 'vitest';
import {
  commandUnits,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  RUNS_ANOTHER_PROGRAMS,
  staticShellCategories,
} from '../catastrophic-command';
import { SHELL_PROGRAMS } from '../shell-programs';

const kinds = (cmd: string) => [...staticShellCategories(cmd)].sort();
const opensOrSends = (cmd: string) => staticShellCategories(cmd).includes('open_or_send');

describe('a program that runs another: what it runs is read (#667, review of #682 pass 2) @cap:executer-une-commande/moteur', () => {
  it('every program documented as running another one has its grammar', () => {
    for (const program of SHELL_PROGRAMS) {
      expect(RUNS_ANOTHER_PROGRAMS, program).toContain(program);
    }
  });

  it('wsl, timeout, nohup, nice, time, env, sudo, doas, runas, busybox, exec, call: what they start is read', () => {
    for (const cmd of [
      'wsl lpr report.pdf',
      'wsl.exe lpr report.pdf',
      'wsl -d Ubuntu -u me xdg-open report.pdf',
      'wsl -e xdg-open report.pdf',
      'wsl -- lp report.pdf',
      'timeout 5 xdg-open report.pdf',
      'timeout -s KILL 10s lp report.pdf',
      'nohup xdg-open report.pdf',
      'nice -n 10 lp report.pdf',
      'time lpr report.pdf',
      'env -i DISPLAY=:0 xdg-open report.pdf',
      'sudo -u me lp report.pdf',
      'doas -u me lp report.pdf',
      'runas /user:admin "notepad /p report.txt"',
      'busybox xdg-open report.pdf',
      'exec xdg-open report.pdf',
      'call notepad /p report.txt',
      'xargs -n 1 lp',
      'find . -name "*.pdf" -exec lp {} ;',
      'for %f in (*.pdf) do start "" %f',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('every kind, not only this one: a deletion or an install started through them is one', () => {
    expect(kinds('wsl rm -rf build')).toEqual(['delete_files']);
    expect(kinds('timeout 60 npm install left-pad')).toEqual(['install_software']);
    expect(kinds('nohup rm -rf build')).toEqual(['delete_files']);
    expect(kinds('xargs -n 1 rm')).toEqual(['delete_files']);
    expect(kinds('for f in *.log; do rm $f; done')).toEqual(['delete_files']);
  });

  it("cmd: every switch before /c or /k is cmd's own", () => {
    for (const cmd of [
      'cmd /q /c start "" report.pdf',
      'cmd /d /c start "" report.pdf',
      'cmd /d /s /c "start "" report.pdf"',
      'cmd.exe /v:on /c lp report.pdf',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
    expect(kinds('cmd /q /c rm -rf build')).toEqual(['delete_files']);
  });

  // Le shell qui lit ce qu'une enveloppe lance est celui de l'enveloppe, pas
  // celui de la ligne autour : un `cmd /c` dans PowerShell lit `start` comme cmd.
  it('the shell that reads the payload is the one of the wrapper that runs it, nested both ways', () => {
    expect(opensOrSends(`powershell -Command "cmd /c start /b 'job' notepad /p report.txt"`)).toBe(
      true,
    );
    expect(opensOrSends(`powershell -Command "cmd /c start /b \\"\\" notepad /p report.txt"`)).toBe(
      true,
    );
    expect(kinds(`powershell -Command "cmd /c start /b 'job' rm -rf build"`)).toContain(
      'delete_files',
    );
    // …and PowerShell inside cmd reads `start` as Start-Process, with no title.
    expect(
      opensOrSends(`cmd /c powershell -Command "start 'C:\\out\\report.pdf' -WindowStyle Hidden"`),
    ).toBe(true);
    expect(kinds(`wsl sh -c "timeout 5 rm -rf build"`)).toEqual(['delete_files']);
  });

  it('everyday commands through a wrapper are not read as reaching out', () => {
    for (const cmd of [
      'wsl git status',
      'wsl --list --verbose',
      'wsl --shutdown',
      'wsl -d Ubuntu -- ls -la',
      'timeout 5 ping host',
      'timeout /t 5 /nobreak',
      'nohup node server.js',
      'nice -n 10 make -j8',
      'time pnpm test',
      'env NODE_ENV=production node build.js',
      'sudo -u postgres psql -c "select 1"',
      'xargs -n 1 echo',
      'find . -name "*.ts" -exec grep -l open {} +',
      'command -v open',
      'exec node server.js',
      'cmd /q /c dir',
      'busybox ls',
      'doskey ls=dir $*',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(false);
    }
  });

  it('the outer program stays a unit, and a wrapper never makes a read look like work', () => {
    expect(commandUnits('timeout 5 xdg-open report.pdf')).toEqual([
      ['timeout', '5', 'xdg-open', 'report.pdf'],
      ['xdg-open', 'report.pdf'],
    ]);
    expect(isDestructiveOrHeavyCommand('sudo wget --version')).toBe(false);
    expect(isCatastrophicCommand('sudo shutdown --help')).toBe(false);
    expect(isCatastrophicCommand('sudo shutdown -h now')).toBe(true);
  });
});
