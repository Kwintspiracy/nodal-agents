// studio/launch-gate.ts — quand Bench Studio a le droit de lancer des essais.
//
// Décision du propriétaire (16/10) : les vrais essais ne tournent JAMAIS sur
// ses agents, seulement dans l'espace « banc » (#758), une copie de son équipe
// sans canal. Le bouton Launch n'est donc actif que lorsque cet espace existe
// et que son contrôle (`pnpm bench:space check`) passe. Tant que ce n'est pas
// le cas, il est désactivé, et la raison est écrite à côté. La même porte est
// tenue côté serveur : une requête de lancement est refusée, jamais seulement
// un bouton grisé.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LaunchGate {
  readonly enabled: boolean;
  /** Pourquoi, en une phrase (anglais : rendu dans Bench Studio). */
  readonly reason: string;
}

type Spawn = (cmd: string, args: string[], cwd: string) => SpawnSyncReturns<string>;

const runPnpm: Spawn = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, shell: true, windowsHide: true });

/** Le script racine qui contrôle l'espace banc, apporté par #758. */
export const BENCH_SPACE_SCRIPT = 'bench:space';

export function launchGate(repo: string, spawn: Spawn = runPnpm): LaunchGate {
  const pkgPath = join(repo, 'package.json');
  const scripts = existsSync(pkgPath)
    ? ((JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> })
        .scripts ?? {})
    : {};
  if (!scripts[BENCH_SPACE_SCRIPT]) {
    return {
      enabled: false,
      reason:
        'Runs launch only against the bench space, a copy of the team with no channel. It arrives with PR #758, not merged yet.',
    };
  }
  const r = spawn('pnpm', [BENCH_SPACE_SCRIPT, 'check'], repo);
  if (r.status === 0) return { enabled: true, reason: '`pnpm bench:space check` passed.' };
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
  return {
    enabled: false,
    reason: `\`pnpm bench:space check\` did not pass${r.status === null ? ' (it did not finish)' : ` (exit ${r.status})`}: ${tail || 'no output'}`,
  };
}
