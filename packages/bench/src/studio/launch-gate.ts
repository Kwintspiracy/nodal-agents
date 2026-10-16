// studio/launch-gate.ts — quand Bench Studio a le droit de lancer des essais.
//
// Décision du propriétaire (16/10) : les vrais essais ne tournent JAMAIS sur
// ses agents, seulement dans l'espace « banc » (#758), une copie de son équipe
// sans canal.
//
// La cible d'un essai n'est jamais RÉSOLUE deux fois : chaque `run_task` démarre
// son propre `mcp serve`, qui choisirait sa cible seul, et ce choix pourrait
// diverger de celui que la porte a jugé. La cible est donc ÉPINGLÉE : la porte
// vérifie un agent, et c'est CE MÊME agent que la session passe à chaque
// `run_task` (`BenchRun.pinnedAgentId`, environnement assaini dans mcp.ts). La
// porte s'ouvre quand les trois faits sont vrais, lus à chaque fois :
//   1. l'espace banc existe ;
//   2. les essais sont épinglés sur un agent DE cet espace ;
//   3. son contrôle (`pnpm bench:space check`) passe.
// Sinon elle est fermée, et la raison est écrite à côté du bouton. La même
// porte est tenue côté serveur : une requête de lancement est refusée, jamais
// seulement un bouton grisé.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ouverte, la porte porte l'agent qu'elle a vérifié : la session épingle celui-là, et aucun autre. */
export type LaunchGate =
  | { readonly enabled: false; readonly reason: string }
  | { readonly enabled: true; readonly reason: string; readonly pinnedAgentId: string };

/** Ce que la porte lit dans la base. */
export interface GateTarget {
  /** L'espace banc, null s'il n'existe pas. */
  readonly benchSpaceId: string | null;
  /** L'agent sur lequel les essais seraient épinglés, et son espace ; null : aucun. */
  readonly pinned: { readonly agentId: string; readonly entityId: string } | null;
}

/**
 * Ce que Bench Studio lit aujourd'hui : l'espace banc, et AUCUN agent épinglé.
 * Le banc n'épingle pas encore ses essais sur la racine de l'espace banc (#769) :
 * tant que ce n'est pas fait, la porte reste fermée, et le dit.
 */
export async function studioGateTarget(
  findBenchSpace: () => Promise<{ readonly id: string } | null>,
): Promise<GateTarget> {
  return { benchSpaceId: (await findBenchSpace())?.id ?? null, pinned: null };
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
      reason: `The bench space and the pinned agent could not be read: ${String(e instanceof Error ? e.message : e)}`,
    };
  }
  if (target.benchSpaceId === null) {
    return {
      enabled: false,
      reason: 'The bench space does not exist yet: create it with `pnpm bench:space sync --apply`.',
    };
  }
  if (target.pinned === null) {
    return {
      enabled: false,
      reason:
        'Trials are not pinned to the bench space yet (#769): without a pinned agent, run_task would reach your own workspace.',
    };
  }
  if (target.pinned.entityId !== target.benchSpaceId) {
    return {
      enabled: false,
      reason: `Trials are pinned to agent ${target.pinned.agentId}, which is not in the bench space.`,
    };
  }
  const r = (deps.spawn ?? runPnpm)('pnpm', [BENCH_SPACE_SCRIPT, 'check'], repo);
  if (r.status === 0) {
    return {
      enabled: true,
      reason: '`pnpm bench:space check` passed.',
      pinnedAgentId: target.pinned.agentId,
    };
  }
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
  return {
    enabled: false,
    reason: `\`pnpm bench:space check\` did not pass${r.status === null ? ' (it did not finish)' : ` (exit ${r.status})`}: ${tail || 'no output'}`,
  };
}
