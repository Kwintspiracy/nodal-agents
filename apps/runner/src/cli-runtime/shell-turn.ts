// cli-runtime/shell-turn.ts — le shell d'un tour de CLI, du départ à la fin (#494).
//
// Les deux chemins CLI (job et chat) passent par ici, pour la même décision
// prise au même endroit :
//
//   - AU DÉPART : la posture (`cliShellPosture`, @nodal-agents/shared), lue
//     avec l'état du frein d'urgence du workspace. Un Codex sous frein ne part
//     pas ; un Claude sous frein part sans shell. Lue DEUX fois : à l'entrée
//     du chemin (rien ne se prépare pour un tour refusé), puis juste avant de
//     lancer la CLI. Entre les deux passent les verrous, la sonde git et la
//     construction du prompt ; un frein serré pendant ce temps partait avec
//     la posture d'avant (revue Codex de #494, passe 3).
//   - PENDANT : un tour qui a un shell surveille le frein. Serré en cours de
//     route, il coupe le processus. Sans ça, retirer la permission laissait
//     tourner des commandes jusqu'à la fin du tour, dix minutes et plus (revue
//     Codex de #494).

import { cliShellPosture, type CliShellPosture, type CodingCli } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { isAutoRunPaused } from '../approvals/rules.ts';

/** L'intervalle de relecture du frein pendant un tour qui a un shell. */
export const BRAKE_WATCH_MS = 5_000;

export async function shellPostureForTurn(
  db: AnyDrizzleDb,
  entityId: string | null,
  cli: CodingCli,
  perms: Parameters<typeof cliShellPosture>[1],
): Promise<CliShellPosture> {
  const autoRunPaused = entityId ? await isAutoRunPaused(db, entityId) : false;
  return cliShellPosture(cli, perms, { autoRunPaused });
}

/** Les outils shell de Claude à autoriser pour ce tour (vide = aucun). */
export function claudeShellTools(posture: CliShellPosture): readonly string[] {
  return posture.kind === 'shell' && posture.tools !== 'sandbox' ? posture.tools : [];
}

export interface BrakeWatch {
  /** À passer au binding : il tue le processus quand le frein se serre. */
  readonly signal: AbortSignal | undefined;
  /** Le frein s'est-il serré pendant le tour ? */
  engaged(): boolean;
  stop(): void;
}

/**
 * Surveille le frein pendant un tour qui a un shell. Un tour sans shell n'a
 * rien à couper : aucune lecture, aucun minuteur.
 *
 * Une lecture du frein qui échoue ne relâche rien et ne coupe rien : elle est
 * journalisée, et la suivante décide. Le frein a été lu au départ du tour ;
 * c'est le serrage EN COURS qu'on guette ici.
 */
export function watchBrakeDuringTurn(
  db: AnyDrizzleDb,
  entityId: string | null,
  posture: CliShellPosture,
  opts: { everyMs?: number; personStop?: AbortSignal } = {},
): BrakeWatch {
  if (posture.kind !== 'shell' || !entityId) {
    return { signal: opts.personStop, engaged: () => false, stop: () => {} };
  }
  const brake = new AbortController();
  let engaged = false;
  const check = (): void => {
    isAutoRunPaused(db, entityId).then(
      (paused) => {
        if (paused && !engaged) {
          engaged = true;
          brake.abort();
        }
      },
      (err: unknown) => console.warn('[cli-runtime] brake read failed during a turn:', err),
    );
  };
  // Une première lecture tout de suite, pas cinq secondes plus tard.
  check();
  const timer = setInterval(check, opts.everyMs ?? BRAKE_WATCH_MS);
  return {
    signal: opts.personStop ? AbortSignal.any([opts.personStop, brake.signal]) : brake.signal,
    engaged: () => engaged,
    stop: () => clearInterval(timer),
  };
}
