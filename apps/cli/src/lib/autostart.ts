// autostart.ts — « Start Nodal when this machine starts » (#451).
//
// Une machine qui redémarre (un Raspberry Pi, un poste toujours allumé) laissait
// Nodal éteint : plus d'automatisation, plus de déclencheur, plus de canal,
// jusqu'à ce que quelqu'un ouvre un terminal. Le CLI inscrit maintenant Nodal
// auprès du gestionnaire de démarrage NATIF de chaque système :
//
//   - Windows : la valeur « Nodal Agents » sous HKCU\…\CurrentVersion\Run,
//     le démarrage PAR UTILISATEUR des applications qui « démarrent avec
//     Windows ». Rien ici ne promet que la page Paramètres → Applications →
//     Démarrage la montre : sur le poste du propriétaire, elle ne l'a pas
//     montrée (validation du 29/09, ticket séparé). Aucun droit admin :
//     une tâche planifiée `schtasks /Create /SC ONLOGON` en exige, avec ou sans
//     `/RU` et `/IT`, et un compte standard recevait « Access is denied ».
//     La valeur lance un petit script `.cmd` (une ligne Run est bornée à 260
//     caractères, et celle d'un poste de dev la dépasse) par
//     `conhost.exe --headless` : aucune fenêtre console à l'ouverture de
//     session (voir `windowsRunCommand`) ;
//   - macOS   : un LaunchAgent (~/Library/LaunchAgents), `RunAtLoad` et
//     `KeepAlive` sur échec ;
//   - Linux   : une unité systemd UTILISATEUR, `Restart=on-failure`. Elle ne
//     démarre au BOOT que si le « linger » est activé, ce que seul
//     `sudo loginctl enable-linger <user>` fait : l'état le dit, avec la
//     commande exacte.
//
// LA VÉRITÉ EST DANS LE SYSTÈME, jamais dans une base : `status` interroge le
// gestionnaire à chaque lecture. Un drapeau stocké dirait « on » au-dessus d'une
// inscription retirée à la main (invariant #4).
//
// L'inscription lance `up` au PREMIER PLAN, jamais `--detach` : détaché, le
// lanceur sort et le superviseur n'a plus rien à surveiller ni à relancer.
// Elle ne DÉMARRE rien tout de suite : une stack tourne déjà quand on bascule
// l'interrupteur, et une seconde se heurterait à ses ports.
//
// Ce module est PUR (textes et lectures de réponses) sauf `runAutostart`, qui
// reçoit ses effets (fichiers, commandes) en paramètre : les tests ne touchent
// ni le registre de la machine, ni ses fichiers.

import { join } from 'path';

export const AUTOSTART_LABEL = 'ai.nodal.agents';
/** Le nom de la valeur sous Run (celui que `reg query` affiche). */
export const WINDOWS_ENTRY_NAME = 'Nodal Agents';
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/**
 * Où Windows garde l'état activé / coupé d'une valeur Run : un binaire dont
 * le premier octet vaut 02 (activé) ou 03 (coupé). Absent, l'entrée est
 * activée. On le LIT, sans dire quel écran de Windows l'a coupée : aucun
 * n'est vérifié pour cette entrée.
 */
export const WINDOWS_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
/** La tâche planifiée des premières versions de #451, que l'inscription et le retrait effacent. */
export const WINDOWS_TASK_NAME = 'Nodal Agents';
export const SYSTEMD_UNIT = 'nodal-agents.service';

/** L'état, tel que le système le dit. */
export type AutostartStatus =
  /** `reason` : l'inscription existe, mais l'utilisateur l'a coupée ailleurs. */
  | { state: 'off'; reason?: string }
  /** Démarre à l'ouverture de session de l'utilisateur. */
  | { state: 'at_login'; lingerCommand?: string }
  /** Démarre au boot, sans session ouverte (Linux avec linger). */
  | { state: 'at_boot' }
  /** Impossible ici, avec la raison. */
  | { state: 'unsupported'; reason: string };

/**
 * La commande que le démarrage lancera : ce CLI, en `up` au premier plan.
 * Refusée quand le script vit dans un cache npx : ce chemin n'existera plus au
 * prochain démarrage, et l'inscription pointerait dans le vide.
 */
export function autostartArgv(cliArgv: readonly string[]): string[] | { refused: string } {
  const script = cliArgv[cliArgv.length - 1] ?? '';
  if (/[\\/]_npx[\\/]/.test(script)) {
    return {
      refused:
        'Nodal runs from the npx cache, which is not there after a restart. ' +
        'Install it with `npm install -g nodal-agents`, then turn this on.',
    };
  }
  return [...cliArgv, 'up'];
}

/** Un argument dans une ligne de `.cmd` Windows. */
function cmdArg(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Le script `.cmd` que la valeur Run lance. */
export function windowsLauncherScript(argv: readonly string[]): string {
  return `@echo off\r\n${argv.map(cmdArg).join(' ')}\r\n`;
}

/**
 * La ligne écrite sous Run, en REG_EXPAND_SZ : Windows y développe
 * `%SystemRoot%`, comme pour sa propre valeur SecurityHealth.
 *
 * `conhost.exe --headless` héberge le script SANS fenêtre. C'est le mode que
 * ConPTY utilise depuis Windows 10 1809 : le binaire et le drapeau sont dans
 * tout Windows 10 et 11 encore maintenu, et il court-circuite Windows Terminal
 * quand celui-ci est le terminal par défaut. Les autres voies laissent une
 * fenêtre : `powershell -WindowStyle Hidden` en montre une le temps de se
 * cacher, et sous Windows Terminal elle reste ; `wscript` + `.vbs` dépend de
 * VBScript, que Microsoft retire de Windows.
 */
export function windowsRunCommand(script: string): string {
  return `%SystemRoot%\\System32\\conhost.exe --headless "${script}"`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Le LaunchAgent macOS. */
export function launchAgentPlist(argv: readonly string[], logDir: string): string {
  const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, 'autostart.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, 'autostart.log'))}</string>
</dict>
</plist>
`;
}

/** Un argument dans `ExecStart=` de systemd. */
function systemdArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

/** L'unité systemd utilisateur. */
export function systemdUserUnit(argv: readonly string[]): string {
  return `[Unit]
Description=Nodal Agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${argv.map(systemdArg).join(' ')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Ce que les commandes du système ont répondu. */
export type CommandAnswer = { exitCode: number; stdout: string };

/**
 * Linux : `systemctl --user is-enabled` puis `loginctl show-user`. `null` pour
 * `isEnabled` : pas de session systemd utilisateur (un conteneur, une image
 * minimale), et on le dit.
 */
export function readLinuxStatus(
  isEnabled: CommandAnswer | null,
  linger: CommandAnswer | null,
  user: string,
): AutostartStatus {
  if (isEnabled === null) {
    return {
      state: 'unsupported',
      reason: 'This machine has no systemd user session (a container or a minimal image).',
    };
  }
  if (isEnabled.stdout.trim() !== 'enabled') return { state: 'off' };
  if (linger !== null && /^Linger=yes$/m.test(linger.stdout)) return { state: 'at_boot' };
  return { state: 'at_login', lingerCommand: `sudo loginctl enable-linger ${user}` };
}

export const WINDOWS_DISABLED_REASON =
  'Windows has this startup entry turned off. Turn this on to enable it again.';

/**
 * Windows : `reg query` de la valeur Run (0 quand elle existe), puis de son
 * entrée StartupApproved. Un premier octet inconnu se dit, il ne devient ni
 * « on » ni « off » (invariant #4).
 */
export function readWindowsStatus(run: CommandAnswer, approved: CommandAnswer): AutostartStatus {
  if (run.exitCode !== 0) return { state: 'off' };
  if (approved.exitCode !== 0) return { state: 'at_login' };
  const first = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(approved.stdout)?.[1];
  if (first === '02') return { state: 'at_login' };
  if (first === '03') return { state: 'off', reason: WINDOWS_DISABLED_REASON };
  return {
    state: 'unsupported',
    reason: `Windows reports a startup state Nodal does not know: ${approved.stdout.trim() || 'empty'}`,
  };
}

/** macOS : un LaunchAgent dans le dossier de l'utilisateur est chargé à sa connexion. */
export function readMacStatus(plistExists: boolean): AutostartStatus {
  return plistExists ? { state: 'at_login' } : { state: 'off' };
}

/** Les effets, fournis par l'appelant. */
export type AutostartEffects = {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  /** Le dossier de Nodal (~/.nodalai), pour le script Windows et les journaux. */
  nodalDir: string;
  run: (cmd: string, args: readonly string[]) => Promise<CommandAnswer | null>;
  writeFile: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
};

function macPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
}

function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function windowsScriptPath(nodalDir: string): string {
  return join(nodalDir, 'autostart.cmd');
}

function regQuery(fx: AutostartEffects, key: string): Promise<CommandAnswer | null> {
  return fx.run('reg', ['query', key, '/v', WINDOWS_ENTRY_NAME]);
}

/** Retire la valeur si elle existe ; un refus se dit. */
async function regDeleteIfPresent(fx: AutostartEffects, key: string): Promise<void> {
  const q = await regQuery(fx, key);
  if (q === null || q.exitCode !== 0) return;
  const r = await fx.run('reg', ['delete', key, '/v', WINDOWS_ENTRY_NAME, '/f']);
  if (r === null || r.exitCode !== 0) {
    throw new Error(
      `Windows refused to remove "${WINDOWS_ENTRY_NAME}" from ${key}: ${r?.stdout.trim() || 'no answer'}`,
    );
  }
}

/**
 * La tâche planifiée d'une installation antérieure : laissée en place, elle
 * lancerait une seconde stack à côté de la valeur Run. Elle part AVANT tout
 * autre geste ; si Windows refuse (une tâche créée en administrateur), rien
 * n'a changé et le message donne la commande exacte.
 */
async function removeLegacyTask(fx: AutostartEffects): Promise<void> {
  const q = await fx.run('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME]);
  if (q === null || q.exitCode !== 0) return;
  const r = await fx.run('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
  if (r === null || r.exitCode !== 0) {
    throw new Error(
      `An older "${WINDOWS_TASK_NAME}" scheduled task exists and Windows refused to remove it ` +
        `(${r?.stdout.trim() || 'no answer'}). Remove it from an administrator terminal: ` +
        `schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`,
    );
  }
}

export async function readAutostartStatus(fx: AutostartEffects): Promise<AutostartStatus> {
  if (fx.platform === 'win32') {
    const run = await regQuery(fx, WINDOWS_RUN_KEY);
    const approved = await regQuery(fx, WINDOWS_APPROVED_KEY);
    if (run === null || approved === null) {
      return { state: 'unsupported', reason: 'reg.exe gave no answer on this machine.' };
    }
    return readWindowsStatus(run, approved);
  }
  if (fx.platform === 'darwin') return readMacStatus(await fx.exists(macPlistPath(fx.home)));
  if (fx.platform === 'linux') {
    const enabled = await fx.run('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]);
    // `is-enabled` répond 1 et « disabled »/« not-found » pour une unité
    // absente : c'est une réponse. Aucune réponse du tout (pas de binaire, pas
    // de bus utilisateur) est l'absence de session.
    const usable = enabled !== null && !/Failed to connect/i.test(enabled.stdout);
    const linger = usable
      ? await fx.run('loginctl', ['show-user', fx.user, '--property=Linger'])
      : null;
    return readLinuxStatus(usable ? enabled : null, linger, fx.user);
  }
  return {
    state: 'unsupported',
    reason: `Starting with the machine is not supported on ${fx.platform}.`,
  };
}

export async function installAutostart(
  cliArgv: readonly string[],
  fx: AutostartEffects,
): Promise<AutostartStatus> {
  const argv = autostartArgv(cliArgv);
  if (!Array.isArray(argv)) return { state: 'unsupported', reason: argv.refused };

  if (fx.platform === 'win32') {
    await removeLegacyTask(fx);
    const script = windowsScriptPath(fx.nodalDir);
    await fx.writeFile(script, windowsLauncherScript(argv));
    const r = await fx.run('reg', [
      'add',
      WINDOWS_RUN_KEY,
      '/v',
      WINDOWS_ENTRY_NAME,
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      windowsRunCommand(script),
      '/f',
    ]);
    if (r === null || r.exitCode !== 0) {
      throw new Error(`reg add ${WINDOWS_RUN_KEY} failed: ${r?.stdout.trim() || 'no answer'}`);
    }
    // Coupée plus tôt côté Windows (StartupApproved) : allumer ici la rallume.
    await regDeleteIfPresent(fx, WINDOWS_APPROVED_KEY);
  } else if (fx.platform === 'darwin') {
    const dir = join(fx.home, 'Library', 'LaunchAgents');
    await fx.mkdir(dir);
    await fx.writeFile(macPlistPath(fx.home), launchAgentPlist(argv, join(fx.nodalDir, 'logs')));
  } else if (fx.platform === 'linux') {
    const before = await readAutostartStatus(fx);
    if (before.state === 'unsupported') return before;
    await fx.mkdir(join(fx.home, '.config', 'systemd', 'user'));
    await fx.writeFile(systemdUnitPath(fx.home), systemdUserUnit(argv));
    for (const args of [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', SYSTEMD_UNIT],
    ]) {
      const r = await fx.run('systemctl', args);
      if (r === null || r.exitCode !== 0) {
        throw new Error(`systemctl ${args.join(' ')} failed: ${r?.stdout.trim() || 'no answer'}`);
      }
    }
  } else {
    return {
      state: 'unsupported',
      reason: `Starting with the machine is not supported on ${fx.platform}.`,
    };
  }
  return readAutostartStatus(fx);
}

export async function uninstallAutostart(fx: AutostartEffects): Promise<AutostartStatus> {
  if (fx.platform === 'win32') {
    await removeLegacyTask(fx);
    await regDeleteIfPresent(fx, WINDOWS_RUN_KEY);
    await regDeleteIfPresent(fx, WINDOWS_APPROVED_KEY);
    await fx.removeFile(windowsScriptPath(fx.nodalDir));
  } else if (fx.platform === 'darwin') {
    await fx.removeFile(macPlistPath(fx.home));
  } else if (fx.platform === 'linux') {
    await fx.run('systemctl', ['--user', 'disable', SYSTEMD_UNIT]);
    await fx.removeFile(systemdUnitPath(fx.home));
    await fx.run('systemctl', ['--user', 'daemon-reload']);
  }
  return readAutostartStatus(fx);
}
