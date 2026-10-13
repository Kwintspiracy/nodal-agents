// service.ts — `nodal-agents service install | uninstall | status` (#451).
//
// Inscrit Nodal auprès du gestionnaire de démarrage natif de la machine (la
// règle vit dans lib/autostart.ts). Par SSH sur une machine sans écran, c'est
// le seul geste ; depuis le dashboard, l'interrupteur de Settings appelle
// cette même commande avec `--json` : le CLI tient l'intégration au système,
// le web ne la réécrit pas.

import { mkdir, rm, stat, writeFile } from 'fs/promises';
import { homedir, userInfo } from 'os';
import { execa } from 'execa';
import chalk from 'chalk';
import { CONFIG_DIR } from '../lib/config.ts';
import { currentCliLaunchArgv } from '../lib/env.ts';
import {
  installAutostart,
  readAutostartStatus,
  uninstallAutostart,
  type AutostartEffects,
  type AutostartStatus,
} from '../lib/autostart.ts';

function effects(): AutostartEffects {
  return {
    platform: process.platform,
    home: homedir(),
    user: userInfo().username,
    nodalDir: CONFIG_DIR,
    run: async (cmd, args) => {
      try {
        const r = await execa(cmd, [...args], { reject: false, all: true, windowsHide: true });
        // Le binaire introuvable n'est pas une réponse du système.
        if ((r as { failed?: boolean; exitCode?: number }).exitCode === undefined) return null;
        return { exitCode: r.exitCode ?? 1, stdout: String(r.all ?? r.stdout ?? '') };
      } catch {
        return null;
      }
    },
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    removeFile: (path) => rm(path, { force: true }),
    exists: async (path) => (await stat(path).catch(() => null)) !== null,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
}

function describe(status: AutostartStatus): string {
  switch (status.state) {
    case 'off':
      return status.reason
        ? `Nodal does not start with this machine. ${status.reason}`
        : 'Nodal does not start with this machine.';
    case 'at_login':
      return status.lingerCommand
        ? `Nodal starts when you log in. To start it at boot, run: ${status.lingerCommand}`
        : 'Nodal starts when you log in.';
    case 'at_boot':
      return 'Nodal starts when this machine boots.';
    case 'unsupported':
      return status.reason;
  }
}

export async function runService(
  action: 'install' | 'uninstall' | 'status',
  opts: { json?: boolean },
): Promise<void> {
  const fx = effects();
  const status =
    action === 'install'
      ? await installAutostart(currentCliLaunchArgv(), fx)
      : action === 'uninstall'
        ? await uninstallAutostart(fx)
        : await readAutostartStatus(fx);
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  const line = describe(status);
  console.log(status.state === 'unsupported' ? chalk.yellow(line) : line);
}
