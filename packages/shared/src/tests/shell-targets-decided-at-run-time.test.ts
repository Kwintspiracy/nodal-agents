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
import { SHELL_PROGRAMS, SHELL_RESERVED_WORDS, isShellProgram } from '../shell-programs';
import {
  RUNS_ANOTHER_PROGRAMS,
  SHELL_KIND_TARGETS,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  programDecidedAtRunTime,
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

  // Mesuré : cmd ne lance aucune cmdlet (`'Remove-Item' is not recognized`).
  // Les paramètres de PowerShell ne se lient que là où PowerShell lit la
  // ligne ; ailleurs, `rm -i ./dist` est rm et son option (passe 1 Nodal, P2).
  it('PowerShell binds its parameters only where PowerShell reads the line', () => {
    for (const flag of ['-i', '-I', '-f -i', '-v'])
      expectEstablished(
        [...sh(`${RM} ${flag} ./dist`), ...cmd(`${RM} ${flag} ./dist`)],
        'delete_files',
      );
  });

  it('programs that run a command with words of their own, read as xargs is: parallel, fd -x', () => {
    expectAsks(
      [
        ...sh(`find . | parallel ${RM} -rf {}`),
        ...sh(`find . | parallel ${RM}`),
        ...sh(`parallel -j 4 '${RM} -rf {}' ::: a b`),
        ...sh(`fd -x ${RM}`),
        ...sh(`fd -e tmp --exec ${RM} {}`),
        ...sh(`fdfind . -X ${RM} -rf`),
        ...sh(`fd --exec-batch ${RM} -rf`),
      ],
      'delete_files',
    );
    expectAsks(sh('pgrep node | parallel kill'), 'stop_programs');
    // like xargs, it runs whatever it is handed: never a program an allowlist may name
    expect(isShellProgram('parallel')).toBe(true);
    expectAsks(sh('fd -t d -x chmod 777'), 'system_settings');
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
    expectEstablished(
      [
        ...powershell('Get-ChildItem src | Remove-Item .\\x.txt'),
        // measured the same way: x.txt and src\a.txt both kept their content
        ...powershell('Get-ChildItem src | Clear-Content .\\x.txt'),
      ],
      'delete_files',
    );
  });

  // Passe 1 Nodal, P2 : les cmdlets du fournisseur qui effacent un contenu ou
  // une entrée n'avaient aucune sorte (`remove-item(?=\s|$)` ratait
  // Remove-ItemProperty) : silencieuses sous « ask » comme sous « allow ».
  it('the provider cmdlets that erase content or an entry are deletions, read as Remove-Item is', () => {
    expectAsks(
      [
        ...powershell('Get-ChildItem secret | Clear-Content'),
        ...powershell('gci secret | clc'),
        ...powershell('gci | Clear-Item'),
        ...powershell('gci | cli'),
        ...powershell('Get-Item HKCU:\\Software\\X | Remove-ItemProperty -Name Y'),
        ...powershell('gi HKCU:\\Software\\X | rp -Name Y'),
        ...powershell('Get-Item HKCU:\\Software\\X | Clear-ItemProperty -Name Y'),
        ...powershell('gi HKCU:\\Software\\X | clp -Name Y'),
        // the path given, the property name left to what the pipeline hands
        ...powershell('Get-ChildItem | Remove-ItemProperty -Path HKCU:\\Software\\X'),
        ...powershell('Clear-Content $log'),
      ],
      'delete_files',
    );
    expectEstablished(
      [
        ...powershell('Clear-Content .\\log.txt'),
        ...powershell('Clear-Content -Path .\\out\\*.log'),
        ...powershell('Remove-ItemProperty -Path HKCU:\\Software\\X -Name Y'),
        ...powershell('Remove-ItemProperty HKCU:\\Software\\X Y'),
        ...powershell('Clear-ItemProperty -LiteralPath HKCU:\\Software\\X -Name Y'),
      ],
      'delete_files',
    );
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

// Passes 2 et 3 Nodal (PR #730) : une option que la grammaire d'un programme
// ne classe pas faisait lire sa valeur comme le programme lancé
// (`parallel --replace X rm -rf X`). La lecture devient opaque : ce qu'il
// lance est décidé à l'exécution, et demande. Et ne plus deviner ne rend
// jamais le plancher plus aveugle : chaque début possible de la commande est
// lu, une destruction cachée derrière l'option reste au plancher (passe 3).
describe('an option a program’s grammar cannot classify makes what it runs opaque (#715) @cap:executer-une-commande/moteur', () => {
  const ROOT = '/';
  const D = `${RM} -rf ${ROOT}`;
  // one per reader that reads options, each hiding D behind one it does not have
  const opaque = [
    `parallel --bogus X ${D} ::: a`,
    `parallel --rep X ${D} ::: a`,
    `sudo --bogus x ${D}`,
    `sudo -Z x ${D}`,
    `timeout --nope 5 ${D}`,
    `env --bogus x ${D}`,
    `nice -19 ${D}`,
    `xargs --bogus ${D}`,
    `bash --bogus x -c '${D}'`,
    `wsl --newflag ${D}`,
    `strace -K x ${D}`,
    `busybox -Z ${D}`,
    `watch -Q 5 ${D}`,
    `flock --bogus lockfile ${D}`,
    `chroot --bogus /srv ${D}`,
  ];

  it('opaque: a program decided at run time, which asks under any autonomy', () => {
    for (const cmd of opaque) {
      expect(programDecidedAtRunTime(cmd, 'posix'), cmd).toBe(true);
      expect(staticShellCategories(cmd, 'posix'), cmd).toContain('inline_code');
      expect(targetsDecidedAtRunTime(cmd, 'posix'), cmd).toContain('inline_code');
      expect(isDestructiveOrHeavyCommand(cmd, 'posix'), cmd).toBe(true);
    }
  });

  it('opaque never blinds the floor: what may run behind the option is read, and reaches it', () => {
    for (const cmd of opaque) {
      expect(isCatastrophicCommand(cmd, 'posix'), cmd).toBe(true);
      expect(staticShellCategories(cmd, 'posix'), cmd).toContain('delete_files');
    }
    // and what is harmless behind it is no destroyer: no hard refusal
    for (const cmd of ['nice -19 make', 'timeout --nope 5 make test', 'sudo -Z x make'])
      expect(isCatastrophicCommand(cmd, 'posix'), cmd).toBe(false);
  });

  it('busybox: `--` ends its options, as every reader’s', () => {
    expect(isCatastrophicCommand(`busybox -- ${D}`, 'posix')).toBe(true);
    expect(staticShellCategories(`busybox -- ${RM} -rf ./x`, 'posix')).toContain('delete_files');
  });

  it('the options each manual holds still find the command, and its kind', () => {
    for (const cmd of [
      `sudo -E -u root ${RM} -rf ./x`,
      `sudo -iu root ${RM} -rf ./x`,
      `xargs -0 -n 1 ${RM}`,
      `xargs --null --max-args=1 ${RM}`,
      `xargs -i ${RM} {}`,
      `xargs -i{} ${RM} {}`,
      `xargs -l1 ${RM}`,
      `xargs -e ${RM}`,
      `parallel -j4 ${RM} {} ::: a b`,
      `parallel --jobs 4 --halt now,fail=1 ${RM} {} ::: a b`,
      // GNU parallel's own table: `--replace` and `-i` take the next word, `--argfile` is `--arg-file`
      `parallel --replace X ${RM} -rf X ::: a`,
      `parallel -i X ${RM} -rf X ::: a`,
      `parallel --argfile jobs.txt ${RM} -rf ./x`,
      `parallel --max-replace-args 2 ${RM} {1} {2} ::: a b`,
      `parallel -J myprofile ${RM} {} ::: a`,
      `timeout -k 5 10 ${RM} -rf ./x`,
      `env -i A=1 ${RM} -rf ./x`,
      `env -S '${RM} -rf ./x'`,
      `nice -n 10 ${RM} -rf ./x`,
      `stdbuf -oL ${RM} -rf ./x`,
      `strace -f -o log ${RM} -rf ./x`,
      `chrt -f 10 ${RM} -rf ./x`,
      `taskset -c 0 ${RM} -rf ./x`,
      `flock -w 5 lockfile -c '${RM} -rf ./x'`,
      `runuser -u bob -- ${RM} -rf ./x`,
      `watch -n 5 ${RM} -rf ./x`,
      `watch -d1 ${RM} -rf ./x`,
      `watch --differences=permanent ${RM} -rf ./x`,
      `unshare -m/run/ns ${RM} -rf ./x`,
      `bash --norc -c '${RM} -rf ./x'`,
      `wsl --system ${RM} -rf ./x`,
    ]) {
      expect(staticShellCategories(cmd, 'posix'), cmd).toContain('delete_files');
      expect(programDecidedAtRunTime(cmd, 'posix'), cmd).toBe(false);
    }
    // and the floor reads what they run, as before
    for (const cmd of [`sudo -E ${D}`, `parallel --replace X ${D} ::: a`, `xargs -i ${D}`])
      expect(isCatastrophicCommand(cmd, 'posix'), cmd).toBe(true);
  });

  it('a glued optional value is no command: `watch -d1 ls` runs ls, unasked as on main', () => {
    for (const cmd of ['watch -d1 ls', 'watch -d ls', 'xargs -l1 echo', 'xargs -i{} echo {}']) {
      expect(programDecidedAtRunTime(cmd, 'posix'), cmd).toBe(false);
      expect(staticShellCategories(cmd, 'posix'), cmd).toEqual([]);
    }
  });

  it('GNU parallel with no command runs its arguments or its input: decided at run time, its arguments read', () => {
    expect(programDecidedAtRunTime('parallel ::: "make a" "make b"', 'posix')).toBe(true);
    expect(staticShellCategories(`parallel ::: '${RM} -rf ./x'`, 'posix')).toContain(
      'delete_files',
    );
    expect(programDecidedAtRunTime('cat jobs.txt | parallel', 'posix')).toBe(true);
  });

  it('what manages a program runs nothing: `wsl --list`, `busybox --list`', () => {
    for (const cmd of ['wsl --list', 'wsl --shutdown', 'busybox --list', 'busybox --help'])
      expect(staticShellCategories(cmd, 'posix'), cmd).toEqual([]);
  });
});

// Passe 4 Nodal (PR #730) : lire chaque façon dont une option inconnue peut
// laisser la commande coûtait 2^k ou Fibonacci(k) (timeout avec 40 options
// inconnues : RangeError après 3 s ; main : 2 ms). La lecture est linéaire en
// mots, et au-delà de MAX_CANDIDATES à travers les imbrications, le reste va
// au plancher comme texte non lu.
describe('reading options that hide the command is linear, and bounded across nesting (#715) @cap:executer-une-commande/moteur', () => {
  const D = `${RM} -rf /`;
  const unknown = (k: number, prefix = '--o') =>
    Array.from({ length: k }, (_, n) => `${prefix}${n}`).join(' ');
  const timed = (cmd: string): { floor: boolean; kinds: StaticShellCategory[]; ms: number } => {
    const t = performance.now();
    const floor = isCatastrophicCommand(cmd, 'posix');
    const kinds = staticShellCategories(cmd, 'posix');
    targetsDecidedAtRunTime(cmd, 'posix');
    return { floor, kinds, ms: performance.now() - t };
  };

  it('60 unknown options: timeout, bash -c, wsl, each read fast, with the verdict of 2', () => {
    for (const k of [2, 60]) {
      for (const [harmless, destroyer] of [
        [`timeout ${unknown(k)} 5 ls`, `timeout ${unknown(k)} 5 ${D}`],
        [`bash ${unknown(k)} -c 'ls'`, `bash ${unknown(k)} -c '${D}'`],
        [`wsl ${unknown(k)} ls`, `wsl ${unknown(k)} ${D}`],
        [`sudo ${unknown(k)} ls`, `sudo ${unknown(k)} ${D}`],
      ] as const) {
        const safe = timed(harmless);
        const bad = timed(destroyer);
        expect(safe.ms, harmless).toBeLessThan(200);
        expect(bad.ms, destroyer).toBeLessThan(200);
        expect(safe.floor, harmless).toBe(false);
        expect(bad.floor, destroyer).toBe(true);
        expect(safe.kinds, harmless).toContain('inline_code');
      }
    }
  });

  it('nested programs whose options hide the command: bounded, never an exception, the floor held', () => {
    const level = (n: number) => `sudo --x${n} env --y${n} timeout --z${n} 5 nice --w${n}`;
    const nested = (levels: number, tail: string) =>
      [...Array.from({ length: levels }, (_, n) => level(n)), tail].join(' ');
    // a few levels: read in full, the same verdict as one
    expect(timed(nested(1, 'ls')).floor).toBe(false);
    expect(timed(nested(1, D)).floor).toBe(true);
    // many: fast, and what lies past what is followed is held by the floor
    for (const levels of [6, 20]) {
      for (const tail of ['ls', D]) {
        const cmd = nested(levels, tail);
        const read = timed(cmd);
        expect(read.ms, cmd).toBeLessThan(200);
        if (tail === D) expect(read.floor, cmd).toBe(true);
      }
    }
  });
});

// Passe 2 Nodal (PR #730) : `npm run cli`, `ls cli` et `echo rp` étaient des
// suppressions pour destructive_gate (motif lu sans ancrage), `./cli test`
// pour la liste. Un alias PowerShell n'en est un que là où PowerShell lit.
describe('a PowerShell alias is one only where PowerShell reads the line (#715) @cap:executer-une-commande/moteur', () => {
  it('cli, clc, clp, rp and ri name any program elsewhere', () => {
    for (const host of ['posix', 'windows'] as const)
      for (const cmd of [
        'npm run cli',
        'ls cli',
        'echo rp',
        './cli test',
        'ri Array',
        'clc',
        'rp x',
      ]) {
        expect(staticShellCategories(cmd, host), `${cmd} (${host})`).not.toContain('delete_files');
        expect(isDestructiveOrHeavyCommand(cmd, host), `${cmd} (${host})`).toBe(false);
      }
  });

  it('read by PowerShell, each is the cmdlet it names', () => {
    for (const alias of ['ri', 'clc', 'cli', 'clp', 'rp']) {
      const cmd = `powershell -Command "${alias} out.txt"`;
      expect(staticShellCategories(cmd, 'windows'), cmd).toContain('delete_files');
      expect(isDestructiveOrHeavyCommand(cmd, 'windows'), cmd).toBe(true);
    }
  });
});

// Passe 2 Nodal (PR #730) : `fd` manquait aux programmes qu'une liste
// autorisée ne peut nommer. La liste est maintenant celle de HANDS_WORDS.
describe('an allowlist may name no program that runs another one (#715) @cap:assigner-outils/moteur', () => {
  it('every program the reading knows runs another one is refused, fd and find included', () => {
    for (const program of [
      'fd',
      'fdfind',
      'find',
      'xargs',
      'parallel',
      'iex',
      'start-process',
      'source',
    ])
      expect(isShellProgram(program), program).toBe(true);
    // one source: a program added to RUNS_ANOTHER is refused, or is a shell's own word
    for (const program of RUNS_ANOTHER_PROGRAMS)
      expect([...SHELL_PROGRAMS, ...SHELL_RESERVED_WORDS], program).toContain(program);
  });
});
