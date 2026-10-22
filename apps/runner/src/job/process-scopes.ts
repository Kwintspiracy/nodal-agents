// job/process-scopes.ts — la FIN DU JOB tue ce que ses commandes ont laissé
// tourner (#628, décision du propriétaire du 14/10).
//
// Les commandes d'un job (`run_command`, `run_skill_script`, ses commandes
// de preuve) tournent dans le PÉRIMÈTRE du job (@nodal-agents/sandbox,
// job-scope.ts) : un serveur lancé par l'une est joint par la suivante. Le
// périmètre se ferme quand le job est FINI — quelle que soit la fin :
//   - succès, échec, annulation (Stop) : son statut devient terminal ;
//   - job perdu : le faucheur le passe en échec, statut terminal aussi ;
//   - ligne disparue : il n'y a plus de job.
// Un job SUSPENDU (une approbation, des délégations attendues) ou remis en
// file pour sa suite (self-chain) n'est PAS fini : ses processus vivent.
//
// Deux points d'appel, un seul critère (`releaseIfEnded`) :
//   - juste après chaque run (`executeJob`) et chaque finalisation hors run
//     (le cron qui compile un job racine) : la fin la plus fréquente, sans
//     délai ;
//   - un balayage périodique de tous les périmètres ouverts : le Stop d'un job
//     suspendu, qu'aucun run ne voit passer, et tout chemin terminal qu'un
//     run ne traverse pas.
// L'arrêt du runner les ferme tous (`closeAllJobProcessScopes`) ; un runner
// qui MEURT laisse mourir ses conteneurs avec lui (job-host.ts, mxc-broker.ts).

import { eq, inArray } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  closeJobProcessScope,
  killLeftoversOfJob,
  openJobProcessScopeIds,
} from '@nodal-agents/sandbox';
import { TERMINAL_STATUSES } from './state.ts';

/** Le balayage : assez court pour qu'un Stop sur un job suspendu se voie vite. */
export const PROCESS_SWEEP_MS = 5_000;

/** La relecture de la ligne pendant une preuve : le Stop la coupe dans ce délai. */
export const JOB_END_POLL_MS = 2_000;

/** Le critère de fin, un seul pour le balayage et la veille : statut terminal, ou ligne absente. */
function hasEnded(status: string | null | undefined): boolean {
  return (
    status === undefined ||
    (status !== null && (TERMINAL_STATUSES as readonly string[]).includes(status))
  );
}

/** Journalisé quand un périmètre est fermé : le job et la raison. */
export const JOB_PROCESSES_RELEASED = 'JOB_PROCESSES_RELEASED';

type Log = (code: string, data: Record<string, unknown>) => void;
const defaultLog: Log = (code, data) =>
  console.warn(`[job-processes] ${code}`, JSON.stringify(data));

/**
 * Ferme les périmètres des jobs FINIS parmi `jobIds` : statut terminal, ou
 * ligne absente. Rend les jobs fermés.
 */
export async function releaseIfEnded(
  db: AnyDrizzleDb,
  jobIds: readonly string[],
  log: Log = defaultLog,
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const rows = await db
    .select({ id: agentJobs.id, status: agentJobs.status })
    .from(agentJobs)
    .where(inArray(agentJobs.id, [...jobIds]));
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const released: string[] = [];
  for (const jobId of jobIds) {
    const s = status.get(jobId);
    if (!hasEnded(s)) continue;
    if (await closeJobProcessScope(jobId)) {
      released.push(jobId);
      log(JOB_PROCESSES_RELEASED, { jobId, status: s ?? 'missing' });
    }
  }
  return released;
}

/**
 * Un job PERDU (#750) — repris d'un runner mort, ou fauché — : ses processus
 * meurent, où qu'ils soient. Ceux que CE runner tient, par son périmètre ;
 * ceux qu'un runner mort a laissés sur cette machine, par l'étiquette du job
 * (Unix ; sous Windows, le noyau les a tués avec le Job Object du mort).
 * Appelée par les deux faucheurs, que le job reparte (repris à son dernier
 * tour) ou non : un processus d'un run mort n'appartient plus à personne.
 */
export async function releaseProcessesOfLostJob(jobId: string): Promise<void> {
  try {
    if (!(await closeJobProcessScope(jobId))) await killLeftoversOfJob(jobId);
  } catch (err) {
    console.error(
      `[job-processes] JOB_PROCESSES_RELEASE_FAILED job=${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Ferme le périmètre de CE job s'il est fini — après un run, après une finalisation. */
export async function releaseJobProcessesIfEnded(db: AnyDrizzleDb, jobId: string): Promise<void> {
  if (!openJobProcessScopeIds().includes(jobId)) return;
  try {
    await releaseIfEnded(db, [jobId]);
  } catch (err) {
    // La ligne illisible : le balayage réessaiera. Dit, jamais avalé.
    console.error(
      `[job-processes] JOB_PROCESSES_RELEASE_FAILED job=${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Le Stop d'un travail qui tourne HORS d'un tour d'outils — la preuve d'un
 * livrable, lancée par la finalisation, que n'importe quelle porte terminale
 * appelle (la boucle, le runtime CLI, le cron du tableau de tâches) : le
 * signal tombe dès que la ligne du job dit qu'il est FINI (le Stop le passe à
 * `cancelled`), par le même critère que le balayage. Une ligne illisible est
 * dite et relue au tour suivant ; elle ne coupe rien.
 */
export function watchJobEnd(
  db: AnyDrizzleDb,
  jobId: string,
  pollMs: number = JOB_END_POLL_MS,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  let reading = false;
  const timer = setInterval(() => {
    if (reading || controller.signal.aborted) return;
    reading = true;
    void db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .then((rows) => {
        if (hasEnded(rows[0]?.status)) {
          clearInterval(timer);
          controller.abort();
        }
      })
      .catch((err: unknown) => {
        console.error(
          `[job-processes] JOB_END_WATCH_UNREADABLE job=${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        reading = false;
      });
  }, pollMs);
  timer.unref();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

/** Le balayage périodique des périmètres ouverts. `stop()` à l'arrêt du runner. */
export function startJobProcessSweep(
  db: AnyDrizzleDb,
  everyMs: number = PROCESS_SWEEP_MS,
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    const open = openJobProcessScopeIds();
    if (open.length === 0) return;
    running = true;
    void releaseIfEnded(db, open)
      .catch((err: unknown) => {
        console.error(
          `[job-processes] JOB_PROCESSES_SWEEP_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
