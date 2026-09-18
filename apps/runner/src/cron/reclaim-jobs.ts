// cron/reclaim-jobs.ts — les jobs qu'un runner mort tenait encore (issue #186).
//
// CE QUI S'EST PASSÉ (18/09/2026, 11:49Z). La stack de dev a été redémarrée
// pendant qu'une délégation de revue tournait. L'enfant `acb2c5c5` est resté
// `processing`, son parent `16d378f5` `awaiting_delegation`, et plus rien n'a
// bougé : aucun appel modèle, aucun appel d'outil après le redémarrage. Le
// faucheur existant (`resetOrphanedJobs`) ne regarde qu'au bout de CINQ minutes,
// et son premier passage n'a lieu que deux minutes après le boot ; surtout, il
// échoue l'enfant sans jamais prévenir le parent, qui se fait faucher à son tour
// cinq minutes plus tard — sa transcription et sa décision avec lui.
//
// CE QUI PROUVE QU'UN JOB N'A PLUS DE PROPRIÉTAIRE. Il n'y a pas de colonne de
// possession sur `agent_jobs`, et il n'en faut pas : un runner vivant BAT le
// cœur de chaque job qu'il tient, toutes les 60 secondes, pendant l'appel modèle
// comme pendant un outil lent (`touchJob`, apps/runner/src/job/execute.ts, et le
// battement du runtime CLI). Un job `processing` dont `updated_at` n'a pas bougé
// depuis plus de deux battements n'est donc tenu par personne. C'est la même
// preuve que le faucheur, lue plus tôt.
//
// CE QUE LA RÈGLE SUPPOSE, ET QUI EST VRAI AUJOURD'HUI : un runner par base. Le
// produit en démarre un, et le mode LAN expose CE runner-là, il n'en ajoute pas.
// Même si un second tournait sur la même base, la règle resterait sûre tant
// qu'il bat : un job qu'il tient ne franchit jamais la fenêtre. Ce qu'elle ne
// couvrirait pas, c'est un runner vivant mais GELÉ, qui ne bat plus — son job
// serait repris alors qu'il pourrait repartir. Le prix est assumé : un job qui
// ne bat plus depuis deux minutes et demie n'avance plus, pour de bon.
//
// CE QU'ON EN FAIT : on ÉCHOUE, on ne reprend pas. Reprendre la transcription
// d'un enfant coupé en plein appel demanderait de savoir ce que le tour
// interrompu avait déjà fait sortir (un message envoyé, un fichier écrit), et
// rejouerait ces gestes. L'échec typé, lui, remonte au parent par le porteur de
// la PR #170, et c'est le PARENT qui décide — redéléguer, faire lui-même, ou le
// dire à la personne. C'est la version la plus petite qui soit vraie.

import { and, eq, inArray, lt } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { resumeDelegated } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { failJob } from '../job/state.ts';
import { notifyJobFailure } from './reset-orphans.ts';

/** Le battement qu'un runner vivant pose sur chaque job qu'il tient. */
export const RUNNER_HEARTBEAT_MS = 60_000;

/**
 * Au-delà de cette fenêtre sans battement, aucun runner vivant ne tient ce job.
 * Deux battements plus une marge : un battement manqué (une requête lente, un
 * `setInterval` en retard) ne suffit pas à déclarer un job abandonné.
 */
export const RUNNER_LIVENESS_WINDOW_MS = 2 * RUNNER_HEARTBEAT_MS + 30_000;

/** Le code machine, pour `agent_jobs.error` — celui que l'issue nomme. */
export const RUNNER_RESTARTED_CODE = 'runner_restarted';

/** Des millisecondes en minutes et secondes, jamais négatives. */
function duree(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

/**
 * La ligne que la personne lit quand son travail est mort avec le runner.
 *
 * Même nature que `timeoutStopLine` et `providerRejectionStopLine` dans le
 * runner : une ligne de PLATEFORME, entre crochets, faite de CHAMPS TYPÉS — le
 * statut où le job a été trouvé, et depuis combien de temps il ne battait plus.
 * Le harnais ne raconte rien, il pose les faits qu'il a (invariant #2).
 */
export function runnerRestartedStopLine(faits: { status: string; idleMs: number }): string {
  return `[stopped: runner restarted — status ${faits.status}, no heartbeat for ${duree(faits.idleMs)}]`;
}

/** Ce qu'une passe de reprise a fait, pour le tick et pour les journaux. */
export interface ReclaimResult {
  /** Jobs passés en `failed` parce que plus personne ne les tenait. */
  reclaimed: number;
  /** Parents remis en marche avec l'échec de leur enfant. */
  parentsResumed: number;
}

/**
 * Reprend les jobs `processing` qu'aucun runner vivant ne tient : ils
 * ÉCHOUENT avec `runner_restarted`, et le parent qui les attendait repart avec
 * cet échec dans son enregistrement de délégation.
 *
 * Appelée AU DÉMARRAGE (le cas de l'issue : le processus qui les tenait vient
 * de mourir) et à chaque tour de cron, qui est sa seconde chance.
 */
export async function reclaimJobsOfDeadRunners(
  db: AnyDrizzleDb,
  opts: { livenessWindowMs?: number; now?: Date } = {},
): Promise<ReclaimResult> {
  const windowMs = opts.livenessWindowMs ?? RUNNER_LIVENESS_WINDOW_MS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowMs);

  const candidates = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      updatedAt: agentJobs.updatedAt,
      parentJobId: agentJobs.parentJobId,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.status, 'processing'), lt(agentJobs.updatedAt, cutoff)));

  const out: ReclaimResult = { reclaimed: 0, parentsResumed: 0 };

  for (const job of candidates) {
    // Un orchestrateur qui a réparti son travail sur le tableau de tâches reste
    // `processing` et NE BAT PLUS — il attend son tableau, il n'est pas mort.
    // Le faucheur le protège déjà à cinq minutes ; le protéger ici aussi est
    // obligatoire, la fenêtre étant bien plus courte (reset-orphans.ts dit
    // l'incident : le parent 7aa6ad96 fauché pendant que ses quatre tâches
    // tournaient).
    const [tacheEnCours] = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(
        and(eq(agentTasks.rootJobId, job.id), inArray(agentTasks.status, ['todo', 'in_progress'])),
      )
      .limit(1);
    if (tacheEnCours) continue;

    const idleMs = now.getTime() - (job.updatedAt?.getTime() ?? now.getTime());
    const ligne = runnerRestartedStopLine({ status: job.status ?? 'processing', idleMs });

    // `failJob` est conditionnelle sur un statut non terminal : un job qui
    // vient de se terminer entre la lecture et ici n'est pas écrasé.
    const landed = await failJob(db, job.id, RUNNER_RESTARTED_CODE, undefined, undefined, ligne);
    if (!landed) continue;
    out.reclaimed += 1;
    await notifyJobFailure(db, job.id, ligne);

    if (await resumeParentOfReclaimedChild(db, job.id, job.parentJobId, ligne)) {
      out.parentsResumed += 1;
    }
  }

  if (out.reclaimed > 0) {
    console.warn(
      `[reclaim-jobs] ${out.reclaimed} job(s) reclaimed from a dead runner, ${out.parentsResumed} parent(s) resumed`,
    );
  }

  return out;
}

/**
 * Remet en marche le parent qui attendait CET enfant, avec l'échec typé.
 *
 * C'est le point de toute l'issue : sans cela le parent reste
 * `awaiting_delegation` jusqu'à ce qu'un faucheur l'achève, et la personne doit
 * reposer sa demande. Avec, il reçoit un enregistrement de délégation en échec,
 * exactement comme pour n'importe quel enfant raté, et il décide.
 *
 * Rend `false` sans lever quand le parent n'attend pas cet enfant NOMMÉMENT
 * (course légitime : annulé, repris entre-temps, ou aucune délégation
 * enregistrée). L'enfant est repris quand même — il est mort, cela ne se
 * discute pas ; c'est le réveil du parent qui n'a pas lieu, et la ligne de
 * journal dit lequel des deux cas s'est produit. Une vraie panne est DITE,
 * fort, et n'arrête pas la passe : les autres jobs repris valent mieux qu'une
 * passe interrompue.
 */
async function resumeParentOfReclaimedChild(
  db: AnyDrizzleDb,
  childJobId: string,
  parentJobId: string | null,
  ligne: string,
): Promise<boolean> {
  if (!parentJobId) return false;

  const [parent] = await db
    .select({ status: agentJobs.status, pendingDelegation: agentJobs.pendingDelegation })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId))
    .limit(1);
  if (!parent || parent.status !== 'awaiting_delegation') return false;

  const pending = parent.pendingDelegation as { subJobId?: string } | null;
  // Le parent doit attendre CET enfant, nommément. Deux cas se ressemblent et
  // n'en sont qu'un (revue de la PR #191, constat 2) : il attend une AUTRE
  // délégation, ou il attend SANS qu'aucune délégation ne soit enregistrée —
  // ligne d'avant le champ, écriture perdue, annulation en cours. Dans les deux
  // cas il n'y a pas d'appel d'outil à qui répondre, et le réveiller poserait un
  // `tool_result` en face d'un `tool_use` qui n'est pas le sien.
  if (pending?.subJobId !== childJobId) {
    console.warn(
      `[reclaim-jobs] parent=${parentJobId} status=awaiting_delegation pending_sub_job_id=${
        pending?.subJobId ?? 'none'
      } reclaimed_child=${childJobId} — not resumed, it is not waiting for this child`,
    );
    return false;
  }

  try {
    await resumeDelegated(
      parentJobId as JobId,
      childJobId as JobId,
      {
        status: 'failed',
        summary: ligne,
        error: RUNNER_RESTARTED_CODE,
        exit_reason: RUNNER_RESTARTED_CODE,
        tools_used: [],
      },
      db,
    );
    return true;
  } catch (err) {
    console.error(
      `[reclaim-jobs] parent ${parentJobId} could not be resumed after child ${childJobId} was reclaimed:`,
      err,
    );
    return false;
  }
}
