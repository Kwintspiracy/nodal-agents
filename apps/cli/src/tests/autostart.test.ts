// autostart.test.ts — « Start Nodal when this machine starts » (#451).
//
// Les textes inscrits (unité systemd, LaunchAgent, script et valeur Run
// Windows) et la LECTURE de l'état, tels que chaque gestionnaire les rend. Les
// effets passent par un faux système qui garde ce qu'on lui a écrit et répond
// comme le vrai, y compris le refus de `schtasks /Create` à un compte standard :
// aucun test ne touche le registre de la machine.
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
  readWindowsStatus,
  systemdUserUnit,
  uninstallAutostart,
  windowsLauncherScript,
  SYSTEMD_UNIT,
  WINDOWS_APPROVED_KEY,
  WINDOWS_DISABLED_REASON,
  WINDOWS_RUN_KEY,
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

describe('Windows : l’état, lu dans Run puis StartupApproved @cap:installer-et-demarrer/moteur', () => {
  const present = { exitCode: 0, stdout: 'Nodal Agents    REG_EXPAND_SZ    x' };
  const absent = {
    exitCode: 1,
    stdout: 'ERROR: The system was unable to find the specified registry key or value.',
  };
  const approved = (bin: string) => ({
    exitCode: 0,
    stdout: `\r\nHKEY_CURRENT_USER\\...\\StartupApproved\\Run\r\n    Nodal Agents    REG_BINARY    ${bin}\r\n`,
  });

  it('pas de valeur Run → off, sans raison', () => {
    expect(readWindowsStatus(absent, absent)).toEqual({ state: 'off' });
  });

  it('valeur Run, pas d’entrée StartupApproved → à la connexion', () => {
    expect(readWindowsStatus(present, absent)).toEqual({ state: 'at_login' });
  });

  it('StartupApproved 02 → à la connexion', () => {
    expect(readWindowsStatus(present, approved('020000000000000000000000'))).toEqual({
      state: 'at_login',
    });
  });

  it('StartupApproved 03 (coupée côté Windows) → off, avec la raison', () => {
    expect(readWindowsStatus(present, approved('03000000F265997C59FFDB01'))).toEqual({
      state: 'off',
      reason: WINDOWS_DISABLED_REASON,
    });
  });

  it('la raison dit ce que Windows répond, sans renvoyer vers un écran de Windows', () => {
    // Validation du 29/09 : l'entrée n'apparaissait pas dans Paramètres →
    // Applications → Démarrage. La raison ne promet donc aucun écran.
    expect(WINDOWS_DISABLED_REASON).toBe(
      'Windows has this startup entry turned off. Turn this on to enable it again.',
    );
    expect(WINDOWS_DISABLED_REASON).not.toMatch(/Settings|Apps|Task Manager/);
  });

  it('un premier octet inconnu se dit, il ne devient ni on ni off', () => {
    const s = readWindowsStatus(present, approved('7F0000000000000000000000'));
    expect(s.state).toBe('unsupported');
    expect((s as { reason: string }).reason).toContain('7F0000000000000000000000');
  });
});

type RegValue = { type: string; data: string };

/** Un faux système : des fichiers en mémoire, et un gestionnaire qui répond comme le vrai. */
function fauxSysteme(
  platform: NodeJS.Platform,
  opts: { legacyTask?: boolean; taskDeleteDenied?: boolean } = {},
) {
  const files = new Map<string, string>();
  const tasks = new Set<string>(opts.legacyTask === true ? [WINDOWS_TASK_NAME] : []);
  const registry = new Map<string, Map<string, RegValue>>();
  const enabledUnits = new Set<string>();
  const calls: string[] = [];
  const denied = { exitCode: 1, stdout: 'ERROR: Access is denied.' };
  const notFound = {
    exitCode: 1,
    stdout: 'ERROR: The system was unable to find the specified registry key or value.',
  };
  const fx: AutostartEffects = {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\q' : '/home/pi',
    user: 'pi',
    nodalDir: platform === 'win32' ? 'C:\\Users\\q\\.nodalai' : '/home/pi/.nodalai',
    run: async (cmd, args): Promise<CommandAnswer | null> => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'schtasks') {
        const tn = args[args.indexOf('/TN') + 1] ?? '';
        // Un compte STANDARD : créer une tâche à l'ouverture de session est
        // refusé, comme sur la machine de l'écran (Windows 11, non admin).
        if (args[0] === '/Create') return denied;
        if (args[0] === '/Delete') {
          if (opts.taskDeleteDenied === true) return denied;
          tasks.delete(tn);
        }
        return { exitCode: args[0] === '/Query' && !tasks.has(tn) ? 1 : 0, stdout: '' };
      }
      if (cmd === 'reg') {
        const [verb, key = ''] = args;
        const name = args[args.indexOf('/v') + 1] ?? '';
        const values = registry.get(key) ?? new Map<string, RegValue>();
        registry.set(key, values);
        if (verb === 'add') {
          values.set(name, {
            type: args[args.indexOf('/t') + 1] ?? 'REG_SZ',
            data: args[args.indexOf('/d') + 1] ?? '',
          });
          return { exitCode: 0, stdout: 'The operation completed successfully.' };
        }
        const v = values.get(name);
        if (v === undefined) return notFound;
        if (verb === 'delete') {
          values.delete(name);
          return { exitCode: 0, stdout: 'The operation completed successfully.' };
        }
        return { exitCode: 0, stdout: `\r\n${key}\r\n    ${name}    ${v.type}    ${v.data}\r\n` };
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
  return { fx, files, tasks, registry, enabledUnits, calls };
}

const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

describe('Windows : la valeur Run, sans droits admin @cap:installer-et-demarrer/moteur', () => {
  const script = join('C:\\Users\\q\\.nodalai', 'autostart.cmd');

  it('les clés sont celles du démarrage PAR UTILISATEUR (HKCU)', () => {
    expect(WINDOWS_RUN_KEY).toBe(RUN);
    expect(WINDOWS_APPROVED_KEY).toBe(APPROVED);
  });

  it('inscrire : `reg add` exact sous Run, lancé sans fenêtre, et l’état se relit', async () => {
    const sys = fauxSysteme('win32');
    const s = await installAutostart(WIN_DEV, sys.fx);
    expect(s).toEqual({ state: 'at_login' });
    expect(sys.files.get(script)).toContain(' up\r\n');
    // conhost héberge cmd.exe, qui exécute le `.cmd` : la forme attestée pour
    // un script batch (vérifiée le 30/09 sur Windows 11, voir autostart.ts).
    const line =
      `%SystemRoot%\\System32\\conhost.exe --headless ` +
      `%SystemRoot%\\System32\\cmd.exe /c "${script}"`;
    expect(sys.calls).toContain(`reg add ${RUN} /v Nodal Agents /t REG_EXPAND_SZ /d ${line} /f`);
    expect(sys.registry.get(RUN)?.get('Nodal Agents')).toEqual({
      type: 'REG_EXPAND_SZ',
      data: line,
    });
    // L'état vient du système : les deux lectures exactes.
    expect(sys.calls).toContain(`reg query ${RUN} /v Nodal Agents`);
    expect(sys.calls).toContain(`reg query ${APPROVED} /v Nodal Agents`);
    // Plus aucune tâche planifiée créée : un compte standard se la voit refuser.
    expect(sys.calls.some((c) => c.startsWith('schtasks /Create'))).toBe(false);
    // Rien n'est DÉMARRÉ : une stack tourne déjà quand on bascule l'interrupteur.
    expect(sys.calls.some((c) => c.startsWith('schtasks /Run'))).toBe(false);
  });

  it('coupée côté Windows → off avec la raison ; rallumer ici efface l’entrée StartupApproved', async () => {
    const sys = fauxSysteme('win32');
    await installAutostart(WIN_DEV, sys.fx);
    // Windows marque l'entrée coupée (premier octet 03 sous StartupApproved).
    sys.registry.set(
      APPROVED,
      new Map([['Nodal Agents', { type: 'REG_BINARY', data: '03000000F265997C59FFDB01' }]]),
    );
    expect(await readAutostartStatus(sys.fx)).toEqual({
      state: 'off',
      reason: WINDOWS_DISABLED_REASON,
    });

    expect(await installAutostart(WIN_DEV, sys.fx)).toEqual({ state: 'at_login' });
    expect(sys.calls).toContain(`reg delete ${APPROVED} /v Nodal Agents /f`);
    expect(sys.registry.get(APPROVED)?.has('Nodal Agents')).toBe(false);
  });

  it('retirer : la valeur Run, son entrée StartupApproved et le script partent', async () => {
    const sys = fauxSysteme('win32');
    await installAutostart(WIN_DEV, sys.fx);
    sys.registry
      .get(APPROVED)!
      .set('Nodal Agents', { type: 'REG_BINARY', data: '020000000000000000000000' });

    expect(await uninstallAutostart(sys.fx)).toEqual({ state: 'off' });
    expect(sys.calls).toContain(`reg delete ${RUN} /v Nodal Agents /f`);
    expect(sys.calls).toContain(`reg delete ${APPROVED} /v Nodal Agents /f`);
    expect(sys.registry.get(RUN)?.size).toBe(0);
    expect(sys.registry.get(APPROVED)?.size).toBe(0);
    expect(sys.files.has(script)).toBe(false);
  });

  it('une ancienne tâche planifiée est effacée, à l’inscription comme au retrait', async () => {
    const aLInscription = fauxSysteme('win32', { legacyTask: true });
    await installAutostart(WIN_DEV, aLInscription.fx);
    expect(aLInscription.calls).toContain(`schtasks /Delete /F /TN ${WINDOWS_TASK_NAME}`);
    expect(aLInscription.tasks.size).toBe(0);

    const auRetrait = fauxSysteme('win32', { legacyTask: true });
    expect(await uninstallAutostart(auRetrait.fx)).toEqual({ state: 'off' });
    expect(auRetrait.tasks.size).toBe(0);
  });

  it('ancienne tâche que Windows refuse d’effacer : dit lisiblement, avant tout autre geste', async () => {
    const sys = fauxSysteme('win32', { legacyTask: true, taskDeleteDenied: true });
    await expect(installAutostart(WIN_DEV, sys.fx)).rejects.toThrow(
      'An older "Nodal Agents" scheduled task exists and Windows refused to remove it ' +
        '(ERROR: Access is denied.). Remove it from an administrator terminal: ' +
        'schtasks /Delete /TN "Nodal Agents" /F',
    );
    // Rien n'a été inscrit à côté : deux lanceurs démarreraient deux stacks.
    expect(sys.registry.get(RUN)?.has('Nodal Agents') ?? false).toBe(false);
    expect(sys.files.size).toBe(0);

    await expect(uninstallAutostart(sys.fx)).rejects.toThrow('refused to remove it');
  });
});

describe('inscrire, puis relire le système @cap:installer-et-demarrer/moteur', () => {
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
