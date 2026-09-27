// lib/runtime-restart.ts — ce que chaque runtime sait faire d'un job que le
// runner a laissé en plein travail en mourant (#443).
//
// UNE déclaration, lue par le faucheur (cron/reclaim-jobs.ts), jamais une
// branche « si c'est Claude, alors… » ailleurs :
//
//   nodal        reprend à son dernier tour sauvegardé (`saveCheckpoint`)
//   claude-code  ne reprend pas : sa session CLI n'a pas de point de reprise Nodal
//   codex        idem : relancer le tour rejouerait la session depuis zéro
//
// Un runtime absent de cette table (une valeur venue d'une base plus récente)
// ne reprend pas, et l'échec le dit par son code.

import { SERVED_CLI_RUNTIMES } from '../cli-runtime/provider.ts';

/** Comment un runtime reprend un job orphelin. */
export type RestartResume = 'from_checkpoint' | 'none';

const RESTART_RESUME: Readonly<Record<string, RestartResume>> = Object.freeze({
  nodal: 'from_checkpoint',
  // Toutes les CLI servies, sans en oublier une : la liste vient de
  // provider.ts, la seule qui les nomme.
  ...Object.fromEntries(SERVED_CLI_RUNTIMES.map((r) => [r, 'none' as const])),
});

/** La capacité de reprise d'un runtime ; `none` pour un runtime inconnu. */
export function restartResumeOf(runtime: string | null | undefined): RestartResume {
  return RESTART_RESUME[runtime ?? 'nodal'] ?? 'none';
}
