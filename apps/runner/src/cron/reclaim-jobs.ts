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
// CE QUI PROUVE QU'UN JOB N'A PLUS DE PROPRIÉTAIRE (#1204). La prise inscrit
// l'instance de runner qui la fait (`agent_jobs.claimed_by`), et un job est
// vivant tant que cette instance tourne — jamais selon l'âge d'une date. C'est
// `judgeHolder` (job/liveness.ts) qui le dit : un job qu'un run de CE processus
// exécute n'est jamais repris ; celui d'une autre instance ne l'est qu'une fois
// cette instance montrée partie (arrêtée proprement, sans inscription, ou
// muette sur l'horloge de la base pendant que celle-ci battait sans trou).
// Avant, la preuve était « `updated_at` n'a pas bougé depuis deux battements
// et demi », lue à l'horloge murale : un portable mis en veille, une horloge
// recalée ou deux hôtes décalés faisaient reprendre au runner les jobs qu'il
// exécutait lui-même, et tuer leurs commandes.
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

import { and, asc, eq, gt, isNull, or } from '@nodal-agents/db';
import {
  agentJobs,
  agentTasks,
  agents,
  approvalRequests,
  gatesACall,
  runnerInstances,
  toolCalls,
} from '@nodal-agents/db';
import type { SweeperObservation } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { resumeDelegated } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { failJob, lastTextOfRun } from '../job/state.ts';
import { budgetDeliverable } from '../job/execute.ts';
import { notifyJobFailure } from './reset-orphans.ts';
import { restartResumeOf } from '../lib/runtime-restart.ts';
import type { RestartResume } from '../lib/runtime-restart.ts';
import { closeElicitationsOfLostJobs } from '../approvals/elicitation.ts';
import { takeLostRun } from './take-lost-run.ts';
import {
  DB_NOW_MS,
  JOB_LIVENESS,
  decideJob,
  judgeHolder,
  processPresence,
} from '../job/liveness.ts';
import type { Holder, JobLivenessSettings, Presence } from '../job/liveness.ts';

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
  //
  // Et seulement les exécutions COMMENCÉES (passe 4) : la porte écrit aussi
  // une ligne pour un appel qu'elle REFUSE (règle `block`, refus déjà
  // prononcé, purpose manquant…), qui n'a jamais tourné. La compter faisait
  // dire au job que l'outil « had already run » : faux. `execution_started`
  // NULL (ligne antérieure, ou `cli:*`) compte, faute de savoir.
  const rows = await db
    .select({ toolName: toolCalls.toolName, riskLevel: toolCalls.riskLevel })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.jobId, jobId),
        gt(toolCalls.seq, checkpointToolSeq ?? 0),
        or(eq(toolCalls.executionStarted, true), isNull(toolCalls.executionStarted)),
      ),
    )
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
  // Seulement les demandes qui gardent un appel (`gatesACall`) : la question
  // d'un serveur MCP (élicitation) n'est pas un effet, elle meurt avec son
  // appel ; ce que l'appel a fait se lit à sa propre marque, plus haut.
  const demandes = await db
    .select({ toolName: approvalRequests.toolName })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.status, 'pending'), gatesACall()),
    );
  for (const d of demandes) if (!noms.includes(d.toolName)) noms.push(d.toolName);
  return noms;
}

/** Les huit premiers caractères d'une identité d'instance : de quoi la reconnaître. */
function court(id: string): string {
  return id.slice(0, 8);
}

/**
 * Ce que le faucheur a constaté du détenteur, en champs typés (#1204) : quelle
 * instance, dans quel état, depuis quand — sur l'horloge de la base.
 */
function faitDuDetenteur(holder: Holder): string {
  switch (holder.kind) {
    case 'self':
      return 'runner (this one) runs none of it';
    case 'gone':
      if (holder.id === null) return 'no holder recorded';
      switch (holder.how) {
        case 'stopped':
          return `runner ${court(holder.id)} stopped at ${holder.stoppedAt?.toISOString() ?? '?'}`;
        case 'silent':
          return `runner ${court(holder.id)} last seen at ${holder.lastSeenAt?.toISOString() ?? '?'}`;
        case 'no_record':
          return `runner ${court(holder.id)} has no instance record`;
        case 'none':
          return 'no holder recorded';
      }
      break;
    case 'alive':
    case 'undecided':
      // Jamais repris : `decideJob` ne rend pas `take_from_holder` pour eux.
      return `runner ${court(holder.id)} last seen at ${holder.lastSeenAt.toISOString()}`;
  }
  return 'holder unknown';
}

/**
 * La ligne que la personne lit quand son travail a été repris à un détenteur
 * parti.
 *
 * Même nature que `timeoutStopLine` et `providerRejectionStopLine` dans le
 * runner : une ligne de PLATEFORME, entre crochets, faite de CHAMPS TYPÉS — le
 * statut où le job a été trouvé, et ce qu'on sait de son détenteur (#1204 :
 * lequel, arrêté ou muet depuis quand), jamais une cause devinée. Le harnais
 * ne raconte rien, il pose les faits qu'il a (invariant #2).
 */
export function runnerRestartedStopLine(faits: {
  status: string;
  holder: Holder;
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
  return `[stopped: no live runner holds this job — status ${faits.status}, ${faitDuDetenteur(faits.holder)}${reprises}${effets}${runtime}${perte}]`;
}

/**
 * Le constat écrit sur la ligne du job repris (`agent_jobs.sweeper_observed`,
 * #1204) : le même fait que la ligne d'arrêt, en champs.
 */
export function observationOfHolder(
  holder: Holder,
  outcome: SweeperObservation['outcome'],
  claimedBy: string | null,
  observedBy: string,
  dbNow: Date,
): SweeperObservation {
  const gone = holder.kind === 'gone' ? holder : null;
  return {
    outcome,
    reason: gone ? 'holder_gone' : 'not_held',
    holder: claimedBy,
    holderState: gone?.how ?? null,
    holderLastSeenAt: gone?.lastSeenAt?.toISOString() ?? null,
    holderStoppedAt: gone?.stoppedAt?.toISOString() ?? null,
    observedBy,
    observedAt: dbNow.toISOString(),
  };
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
 * Reprend les jobs `processing` qu'aucun runner vivant ne tient (#1204 : leur
 * détenteur est parti, ou c'est CETTE instance et aucun de ses runs ne les
 * exécute) : ceux qui ont un point de reprise repartent de leur dernier tour
 * sauvegardé (#443) ; les autres ÉCHOUENT avec leur code, et le parent qui les
 * attendait repart avec cet échec dans son enregistrement de délégation.
 *
 * Appelée AU DÉMARRAGE (le cas de l'issue : le processus qui les tenait vient
 * de mourir) et à chaque tour de cron, qui est sa seconde chance. La décision
 * est celle de `decideJob`, la même pour tout job et tout runtime.
 */
export async function reclaimJobsOfDeadRunners(
  db: AnyDrizzleDb,
  opts: { presence?: Presence; settings?: JobLivenessSettings } = {},
): Promise<ReclaimResult> {
  const presence = opts.presence ?? processPresence;
  const settings = opts.settings ?? JOB_LIVENESS;

  const candidates = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      claimGeneration: agentJobs.claimGeneration,
      claimedBy: agentJobs.claimedBy,
      updatedAt: agentJobs.updatedAt,
      parentJobId: agentJobs.parentJobId,
      task: agentJobs.task,
      messages: agentJobs.messages,
      turn: agentJobs.turn,
      restartResumes: agentJobs.restartResumes,
      checkpointToolSeq: agentJobs.checkpointToolSeq,
      runtime: agents.runtime,
      holderId: runnerInstances.id,
      holderLastSeenAt: runnerInstances.lastSeenAt,
      holderStoppedAt: runnerInstances.stoppedAt,
      dbNowMs: DB_NOW_MS,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .leftJoin(runnerInstances, eq(runnerInstances.id, agentJobs.claimedBy))
    .where(eq(agentJobs.status, 'processing'));

  const out: ReclaimResult = { reclaimed: 0, parentsResumed: 0, resumed: 0, resumedJobIds: [] };

  // Depuis combien de temps CE processus voit chaque ligne inchangée, sur son
  // horloge monotone : ce qui dit qu'un job pris par cette instance, et
  // qu'aucun de ses runs n'exécute, ne bougera plus.
  const vus = presence.stuck.processing.observe(
    candidates.map((c) => ({
      id: c.id,
      signature: `${String(c.claimGeneration)}|${c.claimedBy ?? ''}|${String(c.updatedAt?.getTime() ?? 0)}`,
    })),
    presence.monotonicNow(),
  );

  for (const job of candidates) {
    const dbNow = new Date(Number(job.dbNowMs));
    const holder = judgeHolder(
      {
        jobId: job.id,
        claimedBy: job.claimedBy,
        record:
          job.holderId !== null && job.holderLastSeenAt !== null
            ? { lastSeenAt: job.holderLastSeenAt, stoppedAt: job.holderStoppedAt }
            : null,
        dbNow,
      },
      presence,
      settings,
    );
    // Un orchestrateur qui a réparti son travail sur le tableau de tâches reste
    // `processing` et aucun run ne le tient — il attend son tableau, il n'est
    // pas mort (reset-orphans.ts disait l'incident : le parent 7aa6ad96 fauché
    // pendant que ses quatre tâches tournaient). Sa fin appartient à la
    // compilation du tableau (`deliverCompletedRoots`), que ses tâches tournent
    // encore ou attendent d'être compilées (#1204).
    const [tacheEnCours] = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(eq(agentTasks.rootJobId, job.id))
      .limit(1);
    const verdict = decideJob(
      {
        status: 'processing',
        holder,
        onBoard: tacheEnCours !== undefined,
        stuckForMs: vus.get(job.id) ?? null,
      },
      settings,
    );
    if (verdict.kind !== 'take_from_holder') continue;
    const vu = {
      id: job.id,
      status: 'processing',
      claimGeneration: job.claimGeneration,
    };

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
      //
      // La règle des faucheurs (`takeLostRun`, #750) : la ligne est prise au
      // run perdu et ses processus meurent, ou rien ne se passe ; elle n'est
      // rendue à la file qu'ensuite, sous la prise du faucheur.
      const prise = await takeLostRun(db, vu, presence.instanceId);
      if (prise === null) continue;
      const repris = await db
        .update(agentJobs)
        .set({
          status: 'pending',
          resumedFromTurn: decision.fromTurn,
          restartResumes: (job.restartResumes ?? 0) + 1,
          sweeperObserved: observationOfHolder(
            holder,
            'resumed',
            job.claimedBy,
            presence.instanceId,
            dbNow,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentJobs.id, job.id),
            eq(agentJobs.status, 'processing'),
            eq(agentJobs.claimGeneration, prise),
          ),
        )
        .returning({ id: agentJobs.id });
      if (repris.length === 0) continue;
      // L'appel MCP en cours est mort avec le runner : sa question aussi.
      await closeElicitationsOfLostJobs(db, [job.id]);
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
      holder,
      textRecovered: texte !== '',
      ...(decision.resumesExhausted ? { resumesExhausted: job.restartResumes ?? 0 } : {}),
      ...(decision.blockedBy.length > 0 ? { sideEffects: decision.blockedBy } : {}),
      ...(decision.code === RUNTIME_NOT_RESUMABLE_CODE
        ? { runtimeNotResumable: job.runtime ?? 'unknown' }
        : {}),
    });
    const livrable = budgetDeliverable(texte, '', ligne);

    // `failJob` est conditionnelle sur un statut non terminal : un job qui
    // vient de se terminer entre la lecture et ici n'est pas écrasé. Avant
    // elle, la règle des faucheurs (`takeLostRun`) : la ligne prise au run
    // perdu et ses processus morts, ou rien.
    if ((await takeLostRun(db, vu, presence.instanceId)) === null) {
      continue;
    }
    const landed = await failJob(db, job.id, decision.code, undefined, undefined, livrable);
    if (!landed) continue;
    await closeElicitationsOfLostJobs(db, [job.id]);
    out.reclaimed += 1;
    // Les FAITS, portés par le job : quel détenteur était parti, et depuis
    // quand (#1204) ; quels outils déjà exécutés ont empêché la reprise
    // (#443, l'écran le dira, #444).
    await db
      .update(agentJobs)
      .set({
        sweeperObserved: observationOfHolder(
          holder,
          'failed',
          job.claimedBy,
          presence.instanceId,
          dbNow,
        ),
        ...(decision.blockedBy.length > 0 ? { restartBlockedBy: [...decision.blockedBy] } : {}),
      })
      .where(eq(agentJobs.id, job.id));
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
