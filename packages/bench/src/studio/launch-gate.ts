// studio/launch-gate.ts — quand Bench Studio a le droit de lancer des essais.
//
// Décision du propriétaire (16/10) : les vrais essais ne tournent JAMAIS sur
// ses agents, seulement dans l'espace « banc » (#758), une copie de son équipe
// sans canal. Le bouton Launch n'est donc actif que lorsque les trois faits
// sont vrais, lus à chaque fois :
//   1. l'espace banc existe ;
//   2. les essais le VISENT : l'espace que `run_task` atteint est l'espace banc,
//      pas celui du propriétaire (#758 a créé l'espace sans y diriger le banc) ;
//   3. son contrôle (`pnpm bench:space check`) passe.
// Sinon il est désactivé, et la raison est écrite à côté. La même porte est
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

/** Ce que la porte lit dans la base : l'espace que les essais visent, et l'espace banc. */
export interface GateTarget {
  /** L'espace que `run_task` atteint (`rootEntity`). */
  readonly targetEntityId: string;
  /** L'espace banc, null s'il n'existe pas. */
  readonly benchSpaceId: string | null;
}

type Spawn = (cmd: string, args: string[], cwd: string) => SpawnSyncReturns<string>;

const runPnpm: Spawn = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, shell: true, windowsHide: true });

/** Le script racine qui contrôle l'espace banc, apporté par #758. */
export const BENCH_SPACE_SCRIPT = 'bench:space';

export async function launchGate(
  repo: string,
  deps: { readonly target: () => Promise<GateTarget>; readonly spawn?: Spawn },
): Promise<LaunchGate> {
  const pkgPath = join(repo, 'package.json');
  const scripts = existsSync(pkgPath)
    ? ((JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> })
        .scripts ?? {})
    : {};
  if (!scripts[BENCH_SPACE_SCRIPT]) {
    return {
      enabled: false,
      reason:
        'Runs launch only against the bench space, a copy of the team with no channel. This checkout has no `pnpm bench:space` yet (#758).',
    };
  }
  let target: GateTarget;
  try {
    target = await deps.target();
  } catch (e) {
    return {
      enabled: false,
      reason: `The workspace trials would reach could not be read: ${String(e instanceof Error ? e.message : e)}`,
    };
  }
  if (target.benchSpaceId === null) {
    return {
      enabled: false,
      reason: 'The bench space does not exist yet: create it with `pnpm bench:space sync --apply`.',
    };
  }
  if (target.targetEntityId !== target.benchSpaceId) {
    return {
      enabled: false,
      reason:
        'Trials would still reach your own workspace, not the bench space: the bench does not aim run_task at the bench space yet. Launch opens once it does.',
    };
  }
  const r = (deps.spawn ?? runPnpm)('pnpm', [BENCH_SPACE_SCRIPT, 'check'], repo);
  if (r.status === 0) return { enabled: true, reason: '`pnpm bench:space check` passed.' };
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
  return {
    enabled: false,
    reason: `\`pnpm bench:space check\` did not pass${r.status === null ? ' (it did not finish)' : ` (exit ${r.status})`}: ${tail || 'no output'}`,
  };
}
