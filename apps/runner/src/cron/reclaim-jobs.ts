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
// CE QU'ON EN FAIT (#443) : une seule décision, `orphanDecision`. Un job qui a
// un point de reprise — au moins un tour complet sauvegardé — et qui n'a pas
// épuisé ses reprises REPART de ce tour (`pending`, `resumed_from_turn`) : un
// run de trois heures survit à une mise à jour ou un redémarrage. Le tour
// interrompu est rejoué depuis sa sauvegarde, et les gestes qu'il avait déjà
// faits peuvent l'être une seconde fois : c'est le prix assumé, dit dans
// `orphanDecision`. Sans point de reprise, ou reprises épuisées, le job
// ÉCHOUE : l'échec typé remonte au parent par le porteur de la PR #170, avec
// ce que le job avait écrit (#491), et c'est le PARENT qui décide.

import { and, asc, eq, gt, inArray, lt } from '@nodal-agents/db';
import { agentJobs, agentTasks, agents, approvalRequests, toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { resumeDelegated } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { failJob, lastTextOfRun } from '../job/state.ts';
import { budgetDeliverable } from '../job/execute.ts';
import { notifyJobFailure } from './reset-orphans.ts';
import { restartResumeOf } from '../lib/runtime-restart.ts';
import type { RestartResume } from '../lib/runtime-restart.ts';

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

/**
 * Combien de fois un même job peut être REPRIS après un redémarrage (#443).
 * Au-delà, il échoue avec `RESTART_RESUME_LIMIT_CODE` : un job qui fait tomber
 * le runner à chaque reprise ne doit pas reprendre sans fin.
 */
export const MAX_RESTART_RESUMES = 3;

/** Le code d'un job qui a épuisé ses reprises après redémarrage (#443). */
export const RESTART_RESUME_LIMIT_CODE = 'restart_resume_limit';

/** Le code d'un job dont le runtime ne sait pas reprendre après un redémarrage (#443). */
export const RUNTIME_NOT_RESUMABLE_CODE = 'runtime_not_resumable';

/**
 * Le code d'un job dont le tour interrompu avait déjà fait autre chose que
 * lire (#443, revue Codex passe 1) : le rejouer le referait.
 */
export const RESTART_AFTER_SIDE_EFFECT_CODE = 'restart_after_side_effect';

/** Ce que le faucheur sait d'un job orphelin pour décider. */
export interface OrphanFacts {
  /** La capacité de reprise de son runtime (`lib/runtime-restart.ts`). */
  resume: RestartResume;
  /** Le dernier tour sauvegardé. */
  turn: number | null;
  restartResumes: number | null;
  /**
   * Les outils exécutés APRÈS le point de reprise — le tour interrompu — qui
   * ne font pas que lire (`risk_level` autre que `read`, ou inconnu).
   */
  effectsAfterCheckpoint: readonly string[];
}

/**
 * Ce que le faucheur fait d'un job orphelin — UNE décision (#443).
 *
 * Reprendre, c'est rejouer le tour interrompu depuis le dernier tour
 * sauvegardé (`saveCheckpoint`, en fin de tour complet : appels d'outil et
 * résultats appariés ; le texte partiel d'un appel en cours vivait dans le
 * processus mort). Ce n'est permis que si ce rejeu ne REFAIT rien : pas
 * d'envoi, pas d'écriture, pas de commande — pour un outil approuvé, la
 * personne a approuvé UNE exécution. Sinon le job échoue, avec ce qu'il avait
 * écrit (#491), et le code dit pourquoi :
 *
 *   runtime_not_resumable      son runtime n'a pas de point de reprise Nodal
 *   runner_restarted           mort avant d'avoir sauvegardé un seul tour
 *   restart_resume_limit       déjà repris MAX_RESTART_RESUMES fois
 *   restart_after_side_effect  le tour interrompu avait déjà fait un effet
 */
export function orphanDecision(
  job: OrphanFacts,
):
  | { kind: 'resume'; fromTurn: number }
  | { kind: 'fail'; code: string; resumesExhausted: boolean; blockedBy: readonly string[] } {
  const echec = (
    code: string,
    extra: { resumesExhausted?: boolean; blockedBy?: readonly string[] } = {},
  ) =>
    ({
      kind: 'fail',
      code,
      resumesExhausted: extra.resumesExhausted ?? false,
      blockedBy: extra.blockedBy ?? [],
    }) as const;
  if (job.resume !== 'from_checkpoint') return echec(RUNTIME_NOT_RESUMABLE_CODE);
  const tour = job.turn ?? 0;
  if (tour < 1) return echec(RUNNER_RESTARTED_CODE);
  if ((job.restartResumes ?? 0) >= MAX_RESTART_RESUMES) {
    return echec(RESTART_RESUME_LIMIT_CODE, { resumesExhausted: true });
  }
  if (job.effectsAfterCheckpoint.length > 0) {
    return echec(RESTART_AFTER_SIDE_EFFECT_CODE, { blockedBy: job.effectsAfterCheckpoint });
  }
  return { kind: 'resume', fromTurn: tour };
}

/**
 * Les outils que le tour interrompu a exécutés — ou peut-être exécutés — et
 * qui ne font pas que lire : les lignes `tool_calls` du job postérieures au
 * tour sauvegardé (ou sans tour), dont le `risk_level` n'est pas `read` —
 * NULL compris, comme les lignes `cli:*`. La MARQUE d'intention qu'un tel
 * outil écrit avant de tourner (packages/tools, `markToolStarted`) en est
 * une : sans sortie, elle veut dire « peut-être fait ». Plus les demandes
 * d'approbation en attente. Une par nom, dans l'ordre d'écriture.
 */
async function effectsAfterCheckpoint(
  db: AnyDrizzleDb,
  jobId: string,
  checkpointToolSeq: number | null,
): Promise<string[]> {
  // Par ORDRE d'écriture, jamais par numéro de tour (revue Codex, passe 3) :
  // le rejeu d'un appel APPROUVÉ écrit sa marque au tour déjà sauvegardé, et
  // la compter par `turn > sauvegardé` la laissait passer. Sans ordre connu
  // (sauvegardé avant cette colonne), tout ce que le job a fait compte.
  const rows = await db
    .select({ toolName: toolCalls.toolName, riskLevel: toolCalls.riskLevel })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId), gt(toolCalls.seq, checkpointToolSeq ?? 0)))
    .orderBy(asc(toolCalls.seq));
  const noms: string[] = [];
  for (const r of rows) {
    if (r.riskLevel === 'read') continue;
    if (!noms.includes(r.toolName)) noms.push(r.toolName);
  }
  // Une demande d'approbation EN ATTENTE est posée avant sa ligne d'audit :
  // un job `processing` qui en porte une l'a posée pendant le tour interrompu
  // (une demande d'un tour précédent l'aurait suspendu). Rejouer ce tour
  // reposerait la question, et deux « oui » feraient deux exécutions.
  const demandes = await db
    .select({ toolName: approvalRequests.toolName })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.status, 'pending')));
  for (const d of demandes) if (!noms.includes(d.toolName)) noms.push(d.toolName);
  return noms;
}

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
export function runnerRestartedStopLine(faits: {
  status: string;
  idleMs: number;
  /** Faux quand aucun texte de CE run n'a pu être relu (#491). */
  textRecovered?: boolean;
  /** Le nombre de reprises après redémarrage déjà épuisées, quand il l'est (#443). */
  resumesExhausted?: number;
  /** Les outils déjà exécutés par le tour interrompu, qui empêchent de le rejouer (#443). */
  sideEffects?: readonly string[];
  /** Le runtime qui ne sait pas reprendre, quand c'est la raison (#443). */
  runtimeNotResumable?: string;
}): string {
  const perte = faits.textRecovered === false ? '; no text of this run could be recovered' : '';
  const reprises =
    faits.resumesExhausted !== undefined
      ? `; already resumed ${String(faits.resumesExhausted)} times after a restart`
      : '';
  const effets =
    faits.sideEffects && faits.sideEffects.length > 0
      ? `; not resumed, the interrupted turn had already run: ${faits.sideEffects.join(', ')}`
      : '';
  const runtime =
    faits.runtimeNotResumable !== undefined
      ? `; runtime ${faits.runtimeNotResumable} cannot resume`
      : '';
  return `[stopped: runner restarted — status ${faits.status}, no heartbeat for ${duree(faits.idleMs)}${reprises}${effets}${runtime}${perte}]`;
}

/** Ce qu'une passe de reprise a fait, pour le tick et pour les journaux. */
export interface ReclaimResult {
  /** Jobs passés en `failed` parce que plus personne ne les tenait. */
  reclaimed: number;
  /** Parents remis en marche avec l'échec de leur enfant. */
  parentsResumed: number;
  /** Jobs remis en `pending` à leur dernier tour sauvegardé (#443). */
  resumed: number;
  /** Leurs ids, pour que le démarrage les relance sans attendre le cron. */
  resumedJobIds: string[];
}

/**
 * Reprend les jobs `processing` qu'aucun runner vivant ne tient : ceux qui ont
 * un point de reprise repartent de leur dernier tour sauvegardé (#443) ; les
 * autres ÉCHOUENT avec leur code, et le parent qui les attendait repart avec
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
      task: agentJobs.task,
      messages: agentJobs.messages,
      turn: agentJobs.turn,
      restartResumes: agentJobs.restartResumes,
      checkpointToolSeq: agentJobs.checkpointToolSeq,
      runtime: agents.runtime,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(and(eq(agentJobs.status, 'processing'), lt(agentJobs.updatedAt, cutoff)));

  const out: ReclaimResult = { reclaimed: 0, parentsResumed: 0, resumed: 0, resumedJobIds: [] };

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
    const resume = restartResumeOf(job.runtime);
    const decision = orphanDecision({
      resume,
      turn: job.turn,
      restartResumes: job.restartResumes,
      // Lu seulement quand la question se pose : un runtime qui ne reprend pas,
      // ou un job sans tour sauvegardé, n'a pas de tour à rejouer.
      effectsAfterCheckpoint:
        resume === 'from_checkpoint' && (job.turn ?? 0) >= 1
          ? await effectsAfterCheckpoint(db, job.id, job.checkpointToolSeq)
          : [],
    });

    if (decision.kind === 'resume') {
      // Repart de son dernier tour sauvegardé (#443) : `pending`, le worker le
      // reprend avec ses messages et son `turn` persistés (la boucle amorce
      // tout depuis la ligne). Gardée sur `processing` : un job terminé entre
      // la lecture et ici n'est pas ressuscité. Le parent qui l'attend reste
      // `awaiting_delegation` — il sera repris quand l'enfant finira.
      const repris = await db
        .update(agentJobs)
        .set({
          status: 'pending',
          resumedFromTurn: decision.fromTurn,
          restartResumes: (job.restartResumes ?? 0) + 1,
          updatedAt: now,
        })
        .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, 'processing')))
        .returning({ id: agentJobs.id });
      if (repris.length === 0) continue;
      out.resumed += 1;
      out.resumedJobIds.push(job.id);
      console.warn(
        `[reclaim-jobs] resumed_after_restart job=${job.id} from_turn=${String(decision.fromTurn)} ` +
          `resumes=${String((job.restartResumes ?? 0) + 1)}/${String(MAX_RESTART_RESUMES)}`,
      );
      continue;
    }

    // Ce que CE run avait déjà écrit, suivi de la ligne d'arrêt — la même forme
    // qu'un arrêt sur budget (#442). Sans le texte, le parent ne recevait
    // qu'un échec nu et refaisait le travail (#491) ; les FICHIERS écrits, eux,
    // sont relus par `resumeDelegated` pour toute délégation. Aucun texte de
    // ce run retrouvé : la ligne le dit, jamais un texte d'historique à la place.
    const texte = lastTextOfRun(job.messages, job.task ?? '');
    const ligne = runnerRestartedStopLine({
      status: job.status ?? 'processing',
      idleMs,
      textRecovered: texte !== '',
      ...(decision.resumesExhausted ? { resumesExhausted: job.restartResumes ?? 0 } : {}),
      ...(decision.blockedBy.length > 0 ? { sideEffects: decision.blockedBy } : {}),
      ...(decision.code === RUNTIME_NOT_RESUMABLE_CODE
        ? { runtimeNotResumable: job.runtime ?? 'unknown' }
        : {}),
    });
    const livrable = budgetDeliverable(texte, '', ligne);

    // `failJob` est conditionnelle sur un statut non terminal : un job qui
    // vient de se terminer entre la lecture et ici n'est pas écrasé.
    const landed = await failJob(db, job.id, decision.code, undefined, undefined, livrable);
    if (!landed) continue;
    out.reclaimed += 1;
    // Le FAIT, porté par le job : quels outils déjà exécutés ont empêché la
    // reprise (#443). L'écran le dira (#444).
    if (decision.blockedBy.length > 0) {
      await db
        .update(agentJobs)
        .set({ restartBlockedBy: [...decision.blockedBy] })
        .where(eq(agentJobs.id, job.id));
    }
    await notifyJobFailure(db, job.id, ligne);

    if (await resumeParentOfReclaimedChild(db, job.id, job.parentJobId, livrable, decision.code)) {
      out.parentsResumed += 1;
    }
  }

  if (out.reclaimed > 0 || out.resumed > 0) {
    console.warn(
      `[reclaim-jobs] ${out.reclaimed} job(s) failed and ${out.resumed} resumed from a dead runner, ${out.parentsResumed} parent(s) resumed`,
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
  livrable: string,
  code: string,
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
        summary: livrable,
        error: code,
        exit_reason: code,
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
