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
//
// UN FREIN ILLISIBLE N'EST PAS UN FREIN DESSERRÉ (invariant #4, revue Nodal de
// #551, passe 2). Au départ, un tour qui aurait un shell ne part pas si l'état
// du frein ne se lit pas, et le dit (`auto_run_state_unreadable`). Pendant le
// tour, la même tolérance que la veille de la ligne du job : une lecture ratée
// est journalisée, et à `JOB_ROW_UNREADABLE_MAX` échecs consécutifs le tour est
// coupé, pour la même raison dite.

import {
  cliShellPosture,
  type BrakeStop,
  type CliShellPosture,
  type CodingCli,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { isAutoRunPaused } from '../approvals/rules.ts';
import { JOB_ROW_UNREADABLE_MAX } from '../job/state.ts';

/** L'intervalle de relecture du frein pendant un tour qui a un shell. */
export const BRAKE_WATCH_MS = 5_000;

export async function shellPostureForTurn(
  db: AnyDrizzleDb,
  entityId: string | null,
  cli: CodingCli,
  perms: Parameters<typeof cliShellPosture>[1],
): Promise<CliShellPosture> {
  // Le frein ne décide que d'un tour qui AURAIT un shell : pour les autres, il
  // ne change rien, et son état n'a pas à être lu.
  const unbraked = cliShellPosture(cli, perms, { autoRunPaused: false });
  if (unbraked.kind !== 'shell' || !entityId) return unbraked;
  let autoRunPaused: boolean;
  try {
    autoRunPaused = await isAutoRunPaused(db, entityId);
  } catch (err) {
    console.error(
      `[cli-runtime] AUTO_RUN_STATE_UNREADABLE entity=${entityId} at turn start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: 'refused', reason: 'auto_run_state_unreadable' };
  }
  return cliShellPosture(cli, perms, { autoRunPaused });
}

export interface BrakeWatch {
  /** À passer au binding : il tue le processus quand le frein arrête le tour. */
  readonly signal: AbortSignal | undefined;
  /** Ce qui a arrêté le tour — le frein serré, ou illisible —, `null` sinon. */
  stoppedBy(): BrakeStop | null;
  stop(): void;
}

/**
 * Surveille le frein pendant un tour qui a un shell. Un tour sans shell n'a
 * rien à couper : aucune lecture, aucun minuteur.
 *
 * Le frein a été lu au départ du tour ; c'est le serrage EN COURS qu'on guette
 * ici. Une lecture ratée est journalisée ; `JOB_ROW_UNREADABLE_MAX` ratées de
 * suite coupent le tour (voir l'en-tête).
 */
export function watchBrakeDuringTurn(
  db: AnyDrizzleDb,
  entityId: string | null,
  posture: CliShellPosture,
  opts: { everyMs?: number; personStop?: AbortSignal } = {},
): BrakeWatch {
  if (posture.kind !== 'shell' || !entityId) {
    return { signal: opts.personStop, stoppedBy: () => null, stop: () => {} };
  }
  const brake = new AbortController();
  let stoppedBy: BrakeStop | null = null;
  let unreadable = 0;
  const cut = (why: BrakeStop): void => {
    if (stoppedBy) return;
    stoppedBy = why;
    brake.abort();
  };
  const check = (): void => {
    isAutoRunPaused(db, entityId).then(
      (paused) => {
        unreadable = 0;
        if (paused) cut('auto_run_paused');
      },
      (err: unknown) => {
        unreadable += 1;
        console.warn(
          `[cli-runtime] brake read failed during a turn (${String(unreadable)}/${String(
            JOB_ROW_UNREADABLE_MAX,
          )}):`,
          err,
        );
        if (unreadable >= JOB_ROW_UNREADABLE_MAX) cut('auto_run_state_unreadable');
      },
    );
  };
  // Une première lecture tout de suite, pas cinq secondes plus tard.
  check();
  const timer = setInterval(check, opts.everyMs ?? BRAKE_WATCH_MS);
  return {
    signal: opts.personStop ? AbortSignal.any([opts.personStop, brake.signal]) : brake.signal,
    stoppedBy: () => stoppedBy,
    stop: () => clearInterval(timer),
  };
}
