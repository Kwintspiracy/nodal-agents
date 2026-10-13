// workflows/schedule.ts — la nuit, sans personne : une tâche planifiée Windows.
//
//   pnpm bench:workflows:schedule                  crée (ou remplace) la tâche, chaque jour à 03:00
//   pnpm bench:workflows:schedule --at 04:30       à une autre heure
//   pnpm bench:workflows:schedule --dry-run        montre ce qui serait créé, sans rien créer
//   pnpm bench:workflows:unschedule                supprime la tâche
//
// Outil de développement de CETTE machine, posé par un geste explicite : rien
// ne l'installe tout seul. La tâche lance un petit script `.cmd` (écrit dans
// ~/.nodalai/bench/) qui se place dans ce dépôt et appelle
// `pnpm bench:workflows --scheduled`, sa sortie ajoutée à un journal à côté.
// Elle tourne dans la session de l'utilisateur (celle où tourne la stack), et
// le banc lui-même renonce si le propriétaire travaille.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_NAME = 'Nodal-Agents workflow bench';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DIR = join(homedir(), '.nodalai', 'bench');
const SCRIPT = join(DIR, 'run-workflows.cmd');
const LOG = join(DIR, 'workflows.log');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Le script que la tâche lance. Pur, pour être relu et testé. */
export function wrapperScript(repo: string, log: string): string {
  return [
    '@echo off',
    'rem Nodal-Agents workflow bench, launched by the scheduled task. See packages/bench/src/workflows/schedule.ts',
    `cd /d "${repo}"`,
    `echo ==== %DATE% %TIME% >> "${log}"`,
    `call pnpm bench:workflows --scheduled >> "${log}" 2>&1`,
    '',
  ].join('\r\n');
}

/**
 * Les arguments de `schtasks /Create`, DÉJÀ cités pour la ligne de commande
 * Windows (passés tels quels, `windowsVerbatimArguments`) : un chemin avec des
 * espaces doit arriver à schtasks sous la forme `"\"C:\x y\a.cmd\""`, que
 * la citation automatique de Node ne produit pas. Pur.
 */
export function createArgs(at: string, script: string): string[] {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error(`--at wants HH:MM (24 h), got ${at}`);
  if (script.includes('"'))
    throw new Error(`the script path cannot hold a double quote: ${script}`);
  return [
    '/Create',
    '/TN',
    `"${TASK_NAME}"`,
    '/TR',
    `"\\"${script}\\""`,
    '/SC',
    'DAILY',
    '/ST',
    at,
    '/F',
  ];
}

/** Lance schtasks avec des arguments déjà cités ; un échec lève, avec son code. */
function schtasks(args: string[]): void {
  const r = spawnSync('schtasks', args, { stdio: 'inherit', windowsVerbatimArguments: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`schtasks exited with ${r.status}`);
}

function main(): void {
  const action = process.argv[2];
  if (process.platform !== 'win32') {
    throw new Error(
      `the scheduled task is a Windows tool. Elsewhere, add to crontab: 0 3 * * * cd "${REPO}" && pnpm bench:workflows --scheduled`,
    );
  }
  if (action === 'install') {
    const at = arg('at') ?? '03:00';
    const args = createArgs(at, SCRIPT);
    if (process.argv.includes('--dry-run')) {
      console.log(`would write ${SCRIPT}:\n${wrapperScript(REPO, LOG)}`);
      console.log(`would run: schtasks ${args.join(' ')}`);
      return;
    }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(SCRIPT, wrapperScript(REPO, LOG));
    schtasks(args);
    console.log(`"${TASK_NAME}" runs every day at ${at}: ${SCRIPT}, log in ${LOG}`);
    return;
  }
  if (action === 'remove') {
    schtasks(['/Delete', '/TN', `"${TASK_NAME}"`, '/F']);
    return;
  }
  throw new Error('usage: schedule.ts install [--at HH:MM] [--dry-run] | remove');
}

// Lancé comme script seulement (le test importe les fonctions pures).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
