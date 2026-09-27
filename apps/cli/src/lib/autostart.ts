// autostart.ts — « Start Nodal when this machine starts » (#451).
//
// Une machine qui redémarre (un Raspberry Pi, un poste toujours allumé) laissait
// Nodal éteint : plus d'automatisation, plus de déclencheur, plus de canal,
// jusqu'à ce que quelqu'un ouvre un terminal. Le CLI inscrit maintenant Nodal
// auprès du gestionnaire de démarrage NATIF de chaque système :
//
//   - Windows : une tâche planifiée « à l'ouverture de session » (schtasks),
//     qui lance un petit script `.cmd` (la ligne de commande d'une tâche est
//     bornée à 261 caractères, et celle d'un poste de dev la dépasse) ;
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
// ni le planificateur de la machine, ni ses fichiers.

import { join } from 'path';

export const AUTOSTART_LABEL = 'ai.nodal.agents';
export const WINDOWS_TASK_NAME = 'Nodal Agents';
export const SYSTEMD_UNIT = 'nodal-agents.service';

/** L'état, tel que le système le dit. */
export type AutostartStatus =
  | { state: 'off' }
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

/** Le script `.cmd` que la tâche Windows lance. */
export function windowsLauncherScript(argv: readonly string[]): string {
  return `@echo off\r\n${argv.map(cmdArg).join(' ')}\r\n`;
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

/** Windows : `schtasks /Query /TN` répond 0 quand la tâche existe. */
export function readWindowsStatus(query: CommandAnswer): AutostartStatus {
  return query.exitCode === 0 ? { state: 'at_login' } : { state: 'off' };
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

export async function readAutostartStatus(fx: AutostartEffects): Promise<AutostartStatus> {
  if (fx.platform === 'win32') {
    const q = await fx.run('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME]);
    return readWindowsStatus(q ?? { exitCode: 1, stdout: '' });
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
    const script = windowsScriptPath(fx.nodalDir);
    await fx.writeFile(script, windowsLauncherScript(argv));
    const r = await fx.run('schtasks', [
      '/Create',
      '/F',
      '/TN',
      WINDOWS_TASK_NAME,
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/TR',
      `"${script}"`,
    ]);
    if (r === null || r.exitCode !== 0) {
      throw new Error(`schtasks /Create failed: ${r?.stdout.trim() || 'no answer'}`);
    }
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
    const r = await fx.run('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
    if (r !== null && r.exitCode === 0) await fx.removeFile(windowsScriptPath(fx.nodalDir));
  } else if (fx.platform === 'darwin') {
    await fx.removeFile(macPlistPath(fx.home));
  } else if (fx.platform === 'linux') {
    await fx.run('systemctl', ['--user', 'disable', SYSTEMD_UNIT]);
    await fx.removeFile(systemdUnitPath(fx.home));
    await fx.run('systemctl', ['--user', 'daemon-reload']);
  }
  return readAutostartStatus(fx);
}
