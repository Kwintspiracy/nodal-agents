// job/heartbeat.ts — le battement d'un job, tenu par le runner qui le tient (#565).
//
// CE QUI S'EST PASSÉ (28/09/2026). Le faucheur (`cron/reclaim-jobs.ts`) a
// déclaré mort un job qui tournait : `updated_at` n'avait pas bougé depuis plus
// de deux minutes et demie. Le runner battait PAR ACTIVITÉ — un intervalle de
// 60 s pendant l'appel modèle, un pendant la pré-passe parallèle, un par appel
// d'outil série, un pendant la fenêtre d'approbation, un pendant la reprise
// d'un outil approuvé, un pendant le tour d'une CLI. Une chaîne d'outils de
// 25 s chacun n'en déclenchait aucun : chaque intervalle était effacé avant sa
// première échéance. Tout ce qui n'était pas une de ces activités (la
// préparation du run, le travail entre deux tours, l'après-tour d'une CLI) ne
// battait pas du tout.
//
// LA FORME GÉNÉRALE. Un battement PAR JOB, posé quand le runner le prend
// (`claimJob` a réussi) et retiré seulement quand il le lâche (le run rend la
// main : fini, suspendu, ou perdu), quoi que fasse le job entre les deux. Aucun
// intervalle par activité à garder en phase avec la fenêtre du faucheur.
//
// Le battement n'écrit que sur une ligne `processing` (`touchJob`) : il dit
// « un runner vivant travaille ce job », pas « ce job existe ». Un job suspendu
// (`awaiting_delegation` pendant qu'un enfant tourne en ligne), revenu en
// `pending`, ou terminé par quelqu'un d'autre n'est pas rajeuni par lui — les
// fenêtres des autres faucheurs gardent leur sens.
//
// Un compteur par job : une reprise imbriquée (`return runJob(...)` après une
// délégation) reprend le même job dans le même processus ; elle rejoint le
// battement en cours au lieu d'en poser un second.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { touchJob } from './state.ts';

/** Le battement qu'un runner vivant pose sur chaque job qu'il tient. */
export const RUNNER_HEARTBEAT_MS = 60_000;

interface Battement {
  tenues: number;
  intervalle: ReturnType<typeof setInterval>;
}

const battements = new Map<string, Battement>();

/**
 * Le runner prend ce job : son battement tourne jusqu'à ce que la fonction
 * rendue soit appelée. Appelée une seconde fois, la fonction ne fait rien.
 *
 * Le premier battement tombe `RUNNER_HEARTBEAT_MS` après la prise : `claimJob`
 * vient d'écrire `updated_at`.
 */
export function holdJobHeartbeat(db: AnyDrizzleDb, jobId: string): () => void {
  let battement = battements.get(jobId);
  if (!battement) {
    battement = {
      tenues: 0,
      intervalle: setInterval(() => {
        void touchJob(db, jobId).catch((err: unknown) => {
          // Un battement perdu n'arrête rien : le suivant le remplace, et la
          // fenêtre du faucheur en tolère un. Il est DIT, jamais avalé.
          console.warn(
            `[heartbeat] job=${jobId} beat failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, RUNNER_HEARTBEAT_MS),
    };
    battements.set(jobId, battement);
  }
  battement.tenues += 1;
  const tenu = battement;
  let lache = false;
  return () => {
    if (lache) return;
    lache = true;
    tenu.tenues -= 1;
    if (tenu.tenues > 0) return;
    clearInterval(tenu.intervalle);
    if (battements.get(jobId) === tenu) battements.delete(jobId);
  };
}

/** Les jobs dont CE processus tient le battement — pour les tests et le diagnostic. */
export function heldJobIds(): string[] {
  return [...battements.keys()];
}
