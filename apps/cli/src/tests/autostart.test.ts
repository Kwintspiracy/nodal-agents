// autostart.test.ts — « Start Nodal when this machine starts » (#451).
//
// Les textes inscrits (unité systemd, LaunchAgent, script de la tâche Windows)
// et la LECTURE de l'état, tels que chaque gestionnaire les rend. Les effets
// passent par un faux système qui garde ce qu'on lui a écrit et répond comme
// le vrai : aucun test ne touche le planificateur de la machine.
//
// LA VÉRITÉ EST DANS LE SYSTÈME : l'état se relit après chaque geste, et une
// inscription retirée à la main se lit « off », quoi qu'on ait fait avant.
//
// Mutations vérifiées :
//   - `up` retiré d'`autostartArgv` → les trois textes rougissent ;
//   - la lecture du linger retirée (toujours `at_login`) → « linger actif :
//     au boot » rougit ;
//   - le refus du cache npx retiré → « un cache npx est refusé » rougit.

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  autostartArgv,
  installAutostart,
  launchAgentPlist,
  readAutostartStatus,
  readLinuxStatus,
  systemdUserUnit,
  uninstallAutostart,
  windowsLauncherScript,
  SYSTEMD_UNIT,
  WINDOWS_TASK_NAME,
  type AutostartEffects,
  type CommandAnswer,
} from '../lib/autostart.ts';

const PUBLISHED = ['/usr/bin/node', '/usr/lib/node_modules/nodal-agents/dist/index.js'];
const WIN_DEV = [
  'C:\\Program Files\\nodejs\\node.exe',
  '--import',
  'file:///D:/APPS/NodalAI/node_modules/tsx/dist/loader.mjs',
  'D:\\APPS\\NodalAI\\apps\\cli\\src\\index.ts',
];

describe('ce que le démarrage lancera @cap:installer-et-demarrer/moteur', () => {
  it('ce CLI en `up` au premier plan, jamais `--detach`', () => {
    expect(autostartArgv(PUBLISHED)).toEqual([...PUBLISHED, 'up']);
  });

  it('un cache npx est refusé, avec la raison : il n’existe plus au redémarrage', () => {
    const r = autostartArgv([
      '/usr/bin/node',
      '/home/q/.npm/_npx/abc123/node_modules/nodal-agents/dist/index.js',
    ]);
    expect(Array.isArray(r)).toBe(false);
    expect((r as { refused: string }).refused).toContain('npm install -g nodal-agents');
  });
});

describe('les textes inscrits, par système @cap:installer-et-demarrer/moteur', () => {
  const argv = [...PUBLISHED, 'up'];

  it('Linux : une unité utilisateur, relancée sur échec, voulue par la session', () => {
    expect(systemdUserUnit(argv)).toBe(`[Unit]
Description=Nodal Agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /usr/lib/node_modules/nodal-agents/dist/index.js up
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
  });

  it('macOS : un LaunchAgent au chargement, gardé en vie sur échec', () => {
    const plist = launchAgentPlist(argv, '/Users/q/.nodalai/logs');
    expect(plist).toContain('<string>ai.nodal.agents</string>');
    expect(plist).toContain(
      '    <string>/usr/bin/node</string>\n    <string>/usr/lib/node_modules/nodal-agents/dist/index.js</string>\n    <string>up</string>',
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
  });

  it('Windows : le script de la tâche, un chemin à espaces entre guillemets', () => {
    expect(windowsLauncherScript([...WIN_DEV, 'up'])).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" --import ' +
        'file:///D:/APPS/NodalAI/node_modules/tsx/dist/loader.mjs ' +
        'D:\\APPS\\NodalAI\\apps\\cli\\src\\index.ts up\r\n',
    );
  });
});

describe('l’état, lu dans le système @cap:installer-et-demarrer/moteur', () => {
  it('Linux : activée sans linger → à la connexion, avec la commande exacte du linger', () => {
    expect(
      readLinuxStatus(
        { exitCode: 0, stdout: 'enabled\n' },
        { exitCode: 0, stdout: 'Linger=no\n' },
        'pi',
      ),
    ).toEqual({ state: 'at_login', lingerCommand: 'sudo loginctl enable-linger pi' });
  });

  it('Linux : linger actif → au boot', () => {
    expect(
      readLinuxStatus(
        { exitCode: 0, stdout: 'enabled\n' },
        { exitCode: 0, stdout: 'Linger=yes\n' },
        'pi',
      ),
    ).toEqual({ state: 'at_boot' });
  });

  it('Linux : pas de session systemd utilisateur → impossible, avec la raison', () => {
    const s = readLinuxStatus(null, null, 'pi');
    expect(s.state).toBe('unsupported');
  });

  it('Linux : une unité absente se lit « off »', () => {
    expect(readLinuxStatus({ exitCode: 1, stdout: 'not-found\n' }, null, 'pi')).toEqual({
      state: 'off',
    });
  });
});

/** Un faux système : des fichiers en mémoire, et un gestionnaire qui répond comme le vrai. */
function fauxSysteme(platform: NodeJS.Platform) {
  const files = new Map<string, string>();
  const tasks = new Set<string>();
  const enabledUnits = new Set<string>();
  const calls: string[] = [];
  const fx: AutostartEffects = {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\q' : '/home/pi',
    user: 'pi',
    nodalDir: platform === 'win32' ? 'C:\\Users\\q\\.nodalai' : '/home/pi/.nodalai',
    run: async (cmd, args): Promise<CommandAnswer | null> => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'schtasks') {
        const tn = args[args.indexOf('/TN') + 1] ?? '';
        if (args[0] === '/Create') tasks.add(tn);
        if (args[0] === '/Delete') tasks.delete(tn);
        return { exitCode: args[0] === '/Query' && !tasks.has(tn) ? 1 : 0, stdout: '' };
      }
      if (cmd === 'systemctl') {
        if (args[1] === 'enable') enabledUnits.add(args[2]!);
        if (args[1] === 'disable') enabledUnits.delete(args[2]!);
        if (args[1] === 'is-enabled') {
          return enabledUnits.has(args[2]!)
            ? { exitCode: 0, stdout: 'enabled\n' }
            : { exitCode: 1, stdout: 'not-found\n' };
        }
        return { exitCode: 0, stdout: '' };
      }
      if (cmd === 'loginctl') return { exitCode: 0, stdout: 'Linger=no\n' };
      return null;
    },
    writeFile: async (p, t) => {
      files.set(p, t);
    },
    removeFile: async (p) => {
      files.delete(p);
    },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
  };
  return { fx, files, tasks, enabledUnits, calls };
}

describe('inscrire, puis relire le système @cap:installer-et-demarrer/moteur', () => {
  it('Windows : la tâche à l’ouverture de session lance le script, et l’état se relit', async () => {
    const sys = fauxSysteme('win32');
    const s = await installAutostart(WIN_DEV, sys.fx);
    expect(s).toEqual({ state: 'at_login' });
    const script = join(sys.fx.nodalDir, 'autostart.cmd');
    expect(sys.files.get(script)).toContain(' up\r\n');
    expect(sys.calls).toContain(
      `schtasks /Create /F /TN ${WINDOWS_TASK_NAME} /SC ONLOGON /RL LIMITED /TR "${script}"`,
    );
    // Rien n'est DÉMARRÉ : une stack tourne déjà quand on bascule l'interrupteur.
    expect(sys.calls.some((c) => c.startsWith('schtasks /Run'))).toBe(false);

    expect(await uninstallAutostart(sys.fx)).toEqual({ state: 'off' });
    expect(sys.files.has(script)).toBe(false);
  });

  it('Linux : l’unité est écrite et ACTIVÉE, jamais démarrée ; sans linger, à la connexion', async () => {
    const sys = fauxSysteme('linux');
    const s = await installAutostart(PUBLISHED, sys.fx);
    expect(s).toEqual({ state: 'at_login', lingerCommand: 'sudo loginctl enable-linger pi' });
    expect(sys.files.get(join('/home/pi', '.config', 'systemd', 'user', SYSTEMD_UNIT))).toContain(
      'ExecStart=/usr/bin/node /usr/lib/node_modules/nodal-agents/dist/index.js up',
    );
    expect(sys.calls).toContain(`systemctl --user enable ${SYSTEMD_UNIT}`);
    expect(sys.calls.some((c) => c.includes(' start ') || c.includes('--now'))).toBe(false);
  });

  it('macOS : le LaunchAgent est posé ; retiré à la main, l’état se lit « off »', async () => {
    const sys = fauxSysteme('darwin');
    expect(await installAutostart(PUBLISHED, sys.fx)).toEqual({ state: 'at_login' });
    // Quelqu'un retire le fichier à la main : aucun drapeau ne dit le contraire.
    sys.files.clear();
    expect(await readAutostartStatus(sys.fx)).toEqual({ state: 'off' });
  });

  it('un cache npx ne s’inscrit pas : rien n’est écrit', async () => {
    const sys = fauxSysteme('linux');
    const s = await installAutostart(['/usr/bin/node', '/home/pi/.npm/_npx/x/index.js'], sys.fx);
    expect(s.state).toBe('unsupported');
    expect(sys.files.size).toBe(0);
  });
});
