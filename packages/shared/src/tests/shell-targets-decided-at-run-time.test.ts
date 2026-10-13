// shell-targets-decided-at-run-time.test.ts — what each kind acts on, and
// whether the text establishes it (#715).
//
// Décision du propriétaire (12/10) : quand le texte d'une commande ne peut pas
// établir sur quoi elle agit, une sorte PERMISE demande quand même. C'était
// vrai pour le code en ligne (son programme, #667) et le téléchargement (où il
// écrit, #614) ; ça l'est pour toutes les sortes. Une suppression permise
// tournait sans question quand ses cibles venaient d'un pipeline
// (`Get-ChildItem … | Remove-Item`), de xargs, du `{}` de find, d'une variable
// de boucle cmd, d'une variable ou d'un splat. Chaque cas ci-dessous est lu
// dans le shell qui le lance (PowerShell, cmd, sh), et les formes dont le
// texte établit la cible tournent comme avant.
//
// Les chaînes qui ressemblent à des destructions sont assemblées à
// l'exécution : aucune ligne de ce fichier n'en est une telle quelle.

import { describe, it, expect } from 'vitest';
import {
  SHELL_KIND_TARGETS,
  staticShellCategories,
  targetsDecidedAtRunTime,
  type ScriptShell,
  type ShellHost,
  type StaticShellCategory,
} from '../catastrophic-command';

const RM = 'r' + 'm';
const WIN_ROOT = 'C:' + '\\';
const POSIX_ROOT = '/';

/** One line as each shell that may run it reads it: its own text, and wrapped by another shell. */
type Reading = { cmd: string; host: ShellHost; reader?: ScriptShell; as: string };

/** A PowerShell line: a script's line, the CLI's -Command on Windows and on a posix host (pwsh). */
const powershell = (line: string): Reading[] => [
  { cmd: line, host: 'windows', reader: 'powershell', as: 'ps1 line' },
  { cmd: `powershell -Command "${line}"`, host: 'windows', as: 'powershell -Command' },
  { cmd: `pwsh -Command '${line}'`, host: 'posix', as: 'pwsh -Command (posix)' },
];

/** A cmd line: run_command on Windows, a batch file's line, `cmd /c` from sh. */
const cmd = (line: string): Reading[] => [
  { cmd: line, host: 'windows', as: 'run_command (windows)' },
  { cmd: line, host: 'posix', reader: 'cmd', as: 'batch line' },
  { cmd: `cmd /d /c "${line}"`, host: 'posix', as: 'cmd /c from sh' },
];

/** A sh line: run_command on a posix host, a shell script's line, `bash -c` from cmd. */
const sh = (line: string): Reading[] => [
  { cmd: line, host: 'posix', as: 'run_command (posix)' },
  { cmd: line, host: 'windows', reader: 'sh', as: 'sh script line' },
  { cmd: `bash -c "${line.replace(/"/g, '\\"')}"`, host: 'windows', as: 'bash -c from cmd' },
];

const decided = (r: Reading): StaticShellCategory[] =>
  targetsDecidedAtRunTime(r.cmd, r.host, r.reader);

function expectAsks(readings: Reading[], kind: StaticShellCategory): void {
  for (const r of readings) {
    const at = `${r.cmd} [${r.as}]`;
    // The kind is read first: a target is judged only for a kind the line has.
    expect(staticShellCategories(r.cmd, r.host, r.reader), at).toContain(kind);
    expect(decided(r), at).toContain(kind);
  }
}

function expectEstablished(readings: Reading[], kind: StaticShellCategory): void {
  for (const r of readings) {
    const at = `${r.cmd} [${r.as}]`;
    expect(staticShellCategories(r.cmd, r.host, r.reader), at).toContain(kind);
    expect(decided(r), at).not.toContain(kind);
  }
}

describe('each kind says what it acts on (#715) @cap:executer-une-commande/moteur', () => {
  it('every kind of the checklist has a target, and only inline code and a download read theirs apart', () => {
    expect(SHELL_KIND_TARGETS).toEqual({
      inline_code: 'program',
      delete_files: 'words',
      install_software: 'words',
      download: 'writes',
      open_or_send: 'words',
      stop_programs: 'words',
      system_settings: 'words',
    });
  });
});

describe('delete_files: a target the text does not establish asks (#715) @cap:executer-une-commande/moteur', () => {
  it('PowerShell: what a pipeline hands Remove-Item, in every spelling', () => {
    expectAsks(
      [
        ...powershell(`Get-ChildItem ${WIN_ROOT} -Force | Remove-Item -Recurse -Force`),
        ...powershell(`gci ${WIN_ROOT} | ri -r -fo`),
        ...powershell(`Get-ChildItem -Path ${WIN_ROOT}Windows | Remove-Item -Recurse -Force`),
        ...powershell(`Get-ChildItem ${WIN_ROOT} | ${RM} -Recurse -Force`),
        ...powershell(`gci ${WIN_ROOT} | del -Recurse -Force`),
        // `-Filter` narrows what the pipeline hands; the items still come from it.
        ...powershell(`gci ${WIN_ROOT} | Remove-Item -Filter *.log`),
      ],
      'delete_files',
    );
  });

  it('PowerShell: a variable, a splat, the pipeline variable, an environment variable', () => {
    expectAsks(
      [
        ...powershell('Remove-Item -Recurse -Force $p'),
        ...powershell('Remove-Item @opts'),
        ...powershell('Remove-Item -LiteralPath $target -Force'),
        ...powershell('gci | ForEach-Object { Remove-Item $_.FullName -Force }'),
        ...powershell('Remove-Item -Path $env:TEMP\\build -Recurse'),
        // a sub-expression: `( … )` is its own command, Remove-Item names no path
        ...powershell('Remove-Item (Get-ChildItem . -Recurse) -Force'),
      ],
      'delete_files',
    );
  });

  it('PowerShell: `gci *.tmp | ri` asks: the reading does not establish what an upstream command lists', () => {
    expectAsks(powershell('gci *.tmp | ri'), 'delete_files');
  });

  it('cmd: a loop variable, an environment variable, delayed expansion', () => {
    expectAsks(
      [
        ...cmd(`for /d %i in (${WIN_ROOT}*) do rd /s /q "%i"`),
        ...cmd('for %f in (*.log) do del /q %f'),
        ...cmd('rd /s /q %BUILD_DIR%'),
        ...cmd('setlocal enabledelayedexpansion & del /q !F!'),
      ],
      'delete_files',
    );
  });

  it('cmd: a PowerShell pipeline typed into cmd names no path either', () => {
    expectAsks(
      cmd(`Get-ChildItem ${WIN_ROOT} -Force | Remove-Item -Recurse -Force`),
      'delete_files',
    );
  });

  it('sh: xargs, find -exec, a variable, a substitution, a loop, the home folder', () => {
    expectAsks(
      [
        ...sh(`ls ${POSIX_ROOT} | xargs ${RM} -rf`),
        ...sh(`find ${POSIX_ROOT} -print0 | xargs -0 ${RM} -rf`),
        ...sh(`find ${POSIX_ROOT} -exec ${RM} -rf {} +`),
        ...sh(`find . -name '*.tmp' -exec ${RM} {} \\;`),
        ...sh(`${RM} -rf $DIR`),
        ...sh(`${RM} -rf "$DIR/build"`),
        ...sh(`${RM} -rf $(cat list.txt)`),
        ...sh(`${RM} -rf \`cat list.txt\``),
        ...sh(`for f in ${POSIX_ROOT}*; do ${RM} -rf "$f"; done`),
        ...sh(`${RM} -rf ~/build`),
        ...sh('unlink $LINK'),
        // a program that is not Remove-Item's name, handed what find found
        ...sh("find . -name '*.key' -exec shred -u {} \\;"),
        ...sh('rsync -a --delete src/ $DEST'),
      ],
      'delete_files',
    );
  });

  it('a target the text establishes runs as before, in every shell', () => {
    expectEstablished(
      [
        ...powershell('Remove-Item -Recurse -Force .\\build'),
        ...powershell('Remove-Item .\\build -Recurse -Force -Confirm:$false'),
        ...powershell('Remove-Item -LiteralPath .\\out\\a.txt'),
        ...powershell(`${RM} -Recurse -Force .\\dist`),
        ...cmd('Remove-Item -Recurse -Force .\\build'),
        ...cmd('rd /s /q build'),
        ...cmd('del /q /s build\\*.obj'),
        ...sh(`${RM} -rf ./dist`),
        ...sh(`${RM} -rf build/*.o`),
        ...sh("find . -name '*.pyc' -delete"),
        ...sh('git clean -fdx'),
        ...sh('git reset --hard HEAD~1'),
      ],
      'delete_files',
    );
  });

  // Mesuré (Windows PowerShell 5.1, dossier temporaire) : `Get-ChildItem src |
  // Remove-Item .\x.txt` refuse chaque objet du pipeline (InputObjectNotBound)
  // et ne supprime rien, ni src\*, ni x.txt. Le pipeline ne lie que les
  // paramètres que le texte laisse vides.
  it('a pipeline binds nothing when the text names the path: the target is the one written', () => {
    expectEstablished(powershell('Get-ChildItem src | Remove-Item .\\x.txt'), 'delete_files');
  });
});

describe('every other kind: what the text does not establish asks (#715) @cap:executer-une-commande/moteur', () => {
  it('stop_programs', () => {
    expectAsks(
      [
        ...sh('kill -9 $PID'),
        ...sh('pgrep node | xargs kill'),
        ...powershell('Get-Process node | Stop-Process'),
        ...powershell('Stop-Process -Id $id'),
        ...cmd('taskkill /F /PID %P%'),
      ],
      'stop_programs',
    );
    expectEstablished(
      [
        ...sh('kill 1234'),
        ...cmd('taskkill /F /IM node.exe'),
        ...powershell('Stop-Process -Name node'),
      ],
      'stop_programs',
    );
  });

  it('system_settings', () => {
    expectAsks(
      [
        ...sh('chmod -R 777 $DIR'),
        ...sh('find . -type d -exec chmod 777 {} +'),
        ...cmd('icacls %X% /grant Everyone:F'),
        ...powershell('Get-Item x | Set-Acl -AclObject $acl'),
      ],
      'system_settings',
    );
    expectEstablished(
      [...sh('chmod +x ./run.sh'), ...cmd('icacls build /reset')],
      'system_settings',
    );
  });

  it('install_software', () => {
    expectAsks(
      [
        ...sh('npm install $PKG'),
        ...sh('cat pkgs.txt | xargs npm install'),
        ...cmd('pip install %PKG%'),
      ],
      'install_software',
    );
    expectEstablished(
      [...sh('npm install express'), ...cmd('pip install -r requirements.txt')],
      'install_software',
    );
  });

  it('open_or_send', () => {
    expectAsks(
      [...sh('xdg-open "$FILE"'), ...powershell('Start-Process $f'), ...cmd('start "" %DOC%')],
      'open_or_send',
    );
    expectEstablished(
      [...cmd('start report.pdf'), ...sh('lp -d office report.pdf')],
      'open_or_send',
    );
  });

  it('inline code: its program, as before (#667)', () => {
    expectAsks([...sh('$c report.pdf'), ...cmd('%X% /s /q build')], 'inline_code');
    // Code written into the command is not its program: a variable in it does not ask.
    expectEstablished(
      powershell('Get-ChildItem | ForEach-Object { $_.Name }').slice(1),
      'inline_code',
    );
  });

  it('a download is never judged here: where it writes is judged against the workspaces by the gate', () => {
    for (const r of [...sh('curl -o $OUT https://x.org/a.zip'), ...sh('wget https://x.org/a.zip')])
      expect(decided(r), r.cmd).not.toContain('download');
  });
});
